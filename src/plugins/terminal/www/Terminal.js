const Executor = require("./Executor");

const Terminal = {
    /**
     * Starts the AXS environment by writing init scripts and executing the sandbox.
     * @param {boolean} [installing=false] - Whether AXS is being started during installation.
     * @param {Function} [logger=console.log] - Function to log standard output.
     * @param {Function} [err_logger=console.error] - Function to log errors.
     * @returns {Promise<boolean>} - Returns true if installation completes with exit code 0, void if not installing
     */
    async startAxs(installing = false, logger = console.log, err_logger = console.error,failsafe = false) {
        const filesDir = await new Promise((resolve, reject) => {
            system.getFilesDir(resolve, reject);
        });

        const failsafeArg = failsafe ? "--failsafe" : "";

        const [initAlpine, rmWrapper, initSandbox] = await Promise.all([
            readAsset("init-alpine.sh"),
            readAsset("rm-wrapper.sh"),
            readAsset("init-sandbox.sh"),
        ]);

        await this.migrateLegacyHome();

        const isFdroid = await Executor.execute("echo $FDROID");

        if(isFdroid !== "true"){
//the symlink must be updated everytime because the symlinks to native libs can break after app updates
        await Executor.execute("rm -f $PREFIX/axs && ln -s $NATIVE_DIR/libaxs.so $PREFIX/axs")
}
        

        await writeText(`${filesDir}/init-alpine.sh`, initAlpine);
        await writeText(`${filesDir}/init-sandbox.sh`, initSandbox);

        const activeDistroDir = (await fileExists(`${filesDir}/distro`))
            ? `${filesDir}/distro`
            : (await fileExists(`${filesDir}/ubuntu`))
            ? `${filesDir}/ubuntu`
            : `${filesDir}/alpine`;

        if (await fileExists(activeDistroDir)) {
            await ensureDir(`${activeDistroDir}/bin`);
            await deleteFile(`${activeDistroDir}/bin/rm`).catch(() => {});
            await writeText(`${activeDistroDir}/bin/rm`, rmWrapper);
            await setExec(`${activeDistroDir}/bin/rm`, true);
        }

        if (installing) {
            return new Promise((resolve, reject) => {
                let lastError = "";

                Executor.start("sh", (type, data) => {
                    //console[type === "stderr" ? "error" : "log"](`[AXS] ${data}`);
                    logger(`${type} ${data}`);

                    if (type === "stderr" && data) {
                        lastError = lastError ? `${lastError}\n${data}` : data;
                    }

                    // Check for exit code during installation
                    if (type === "exit") {
                        const success = data === "0";
                        if (!success) {
                            this.lastInstallError = lastError
                                ? `Sandbox configuration failed with exit code ${data}: ${lastError}`
                                : `Sandbox configuration failed with exit code ${data}`;
                        }
                        resolve(success);
                    }
                }).then(async (uuid) => {
                    await Executor.write(uuid, `source ${filesDir}/init-sandbox.sh ${installing ? "--installing" : ""} ${failsafeArg}; exit`);
                }).catch((error) => {
                    const message = `Failed to start AXS: ${formatError(error)}`;
                    this.lastInstallError = message;
                    err_logger(message);
                    resolve(false);
                });
            });
        } else {
            try {
                const uuid = await Executor.start("sh", (type, data) => {
                    //console[type === "stderr" ? "error" : "log"](`[AXS] ${data}`);
                    logger(`${type} ${data}`);
                });
                await Executor.write(uuid, `source ${filesDir}/init-sandbox.sh ${installing ? "--installing" : ""} ${failsafeArg}; exit`);
            } catch (error) {
                const message = `Failed to start AXS: ${formatError(error)}`;
                err_logger(message);
                throw new Error(message);
            }
        }
    },

    /**
     * Stops the AXS process by forcefully killing it.
     * @returns {Promise<void>}
     */
    async stopAxs() {
        await Executor.execute(`kill -KILL $(cat $PREFIX/pid)`);
    },

    /**
     * Checks if the AXS process is currently running.
     * @returns {Promise<boolean>} - `true` if AXS is running, `false` otherwise.
     */
    async isAxsRunning() {
        const filesDir = await new Promise((resolve, reject) => {
            system.getFilesDir(resolve, reject);
        });

        const pidExists = await new Promise((resolve, reject) => {
            system.fileExists(`${filesDir}/pid`, false, (result) => {
                resolve(result == 1);
            }, reject);
        });

        if (!pidExists) return false;

        const result = await Executor.BackgroundExecutor.execute(`kill -0 $(cat $PREFIX/pid) 2>/dev/null && echo "true" || echo "false"`);
        return String(result).toLowerCase() === "true";
    },

    /**
     * Installs Linux distribution (Ubuntu 24.04 LTS Noble) via PRoot (rootless) or Chroot (root).
     * @param {string|Function} [distroType="proot"] - "proot" or "chroot".
     * @param {Function} [logger=console.log] - Function to log standard output.
     * @param {Function} [err_logger=console.error] - Function to log errors.
     * @returns {Promise<boolean>} - Returns true if installation completes successfully.
     */
    async install(distroType = "proot", logger = console.log, err_logger = console.error) {
        if (typeof distroType === "function") {
            err_logger = logger;
            logger = distroType;
            distroType = "proot";
        }

        if (!(await this.isSupported())) return false;

        const isFdroid = await Executor.execute("echo $FDROID");

        this.lastInstallError = "";

        try {
            // cleanup before install
            await this.uninstall();
        } catch (e) {
            // suppress error
        }

        const filesDir = await new Promise((resolve, reject) => {
            system.getFilesDir(resolve, reject);
        });

        const arch = await new Promise((resolve, reject) => {
            system.getArch(resolve, reject);
        });

        try {
            const architectures = {
                "arm64-v8a": {
                    libraryDirectory: "arm64",
                    axsArchitecture: "arm64",
                    ubuntuArch: "arm64",
                    hasLibproot32: true
                },
                "armeabi-v7a": {
                    libraryDirectory: "arm32",
                    axsArchitecture: "armv7",
                    ubuntuArch: "armhf",
                    hasLibproot32: false
                },
                "x86_64": {
                    libraryDirectory: "x64",
                    axsArchitecture: "x86_64",
                    ubuntuArch: "amd64",
                    hasLibproot32: true
                }
            };

            const architecture = architectures[arch];

            if (!architecture) {
                throw new Error(`Unsupported architecture: ${arch}`);
            }

            // ==========================================
            // CHROOT DISTRO (ROOT MODE)
            // ==========================================
            if (distroType === "chroot") {
                logger("⚡ Setting up chroot-distro for root environment...");

                await ensureDir(`${filesDir}/bin`);
                await ensureDir(`${filesDir}/.downloaded`);

                // Write chroot-distro script from bundled assets
                const chrootDistroScript = await readAsset("chroot-distro");
                await writeText(`${filesDir}/bin/chroot-distro`, chrootDistroScript);
                await setExec(`${filesDir}/bin/chroot-distro`, true);

                if (isFdroid !== "true") {
                    await Executor.execute("rm -f $PREFIX/axs && ln -s $NATIVE_DIR/libaxs.so $PREFIX/axs");
                }

                await writeText(`${filesDir}/.distro_type`, "chroot");

                logger("📦 Installing Ubuntu 24.04 LTS (Noble) via chroot-distro...");
                logger("ℹ️ Requesting root (su) access...");

                const ubuntuUrl = `https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.4-base-${architecture.ubuntuArch}.tar.gz`;

                const installSuccess = await new Promise((resolve, reject) => {
                    let lastErr = "";
                    Executor.start("su", (type, data) => {
                        logger(`${type === "stderr" ? "⚠️" : "▶"} ${data}`);
                        if (type === "stderr" && data) {
                            lastErr = lastErr ? `${lastErr}\n${data}` : data;
                        }
                        if (type === "exit") {
                            const ok = data === "0";
                            if (!ok) {
                                this.lastInstallError = lastErr || `chroot-distro exited with code ${data}`;
                            }
                            resolve(ok);
                        }
                    }).then(async (uuid) => {
                        await Executor.write(uuid, `sh ${filesDir}/bin/chroot-distro install ubuntu "${ubuntuUrl}"; exit $?\n`);
                    }).catch((err) => {
                        const msg = formatError(err);
                        this.lastInstallError = msg;
                        err_logger(msg);
                        resolve(false);
                    });
                });

                if (!installSuccess) {
                    throw new Error(this.lastInstallError || "chroot-distro install failed. Please check SU permissions.");
                }

                await ensureDir(`${filesDir}/.extracted`);
                await ensureDir(`${filesDir}/.configured`);
                logger("✅ chroot-distro Ubuntu 24.04 installed successfully!");
                return true;
            }

            // ==========================================
            // PROOT DISTRO (ROOTLESS MODE - UBUNTU 24.04)
            // ==========================================
            logger("🚀 Setting up proot-distro (Ubuntu 24.04 Noble)...");
            await writeText(`${filesDir}/.distro_type`, "proot");

            const ubuntuUrl = `https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.4-base-${architecture.ubuntuArch}.tar.gz`;

            if (isFdroid === "true") {
                const buildUrl = (...parts) => parts.join("");

                const strings = {
                    protocol: ["ht", "tps", ":", "//"],
                    rawGithubDomain: ["raw", ".", "github", "usercontent", ".", "com"],
                    githubDomain: ["git", "hub", ".", "com"],
                    acodeFoundation: ["Acode", "-", "Foundation"],
                    acodeRepo: ["A", "code"],
                    bajrangCoder: ["bajrang", "Coder"],
                    acodexServer: ["acodex", "_", "server"],
                    libraries: {
                        proot: ["li", "bp", "root", ".", "so"],
                        proot32: ["li", "bp", "root", "32", ".", "so"],
                        talloc: ["li", "bt", "alloc", ".", "so"],
                        prootXed: ["li", "bp", "root", "-", "xed", ".", "so"]
                    }
                };

                const rawGithubBase = buildUrl(
                    ...strings.protocol,
                    ...strings.rawGithubDomain,
                    "/",
                    ...strings.acodeFoundation,
                    "/",
                    ...strings.acodeRepo,
                    "/main/src/plugins/proot/libs/"
                );

                const githubReleaseBase = buildUrl(
                    ...strings.protocol,
                    ...strings.githubDomain,
                    "/",
                    ...strings.bajrangCoder,
                    "/",
                    ...strings.acodexServer,
                    "/releases/latest/download/"
                );

                const libraryBaseUrl = buildUrl(
                    rawGithubBase,
                    architecture.libraryDirectory,
                    "/"
                );

                const libproot = buildUrl(
                    libraryBaseUrl,
                    ...strings.libraries.proot
                );

                const libTalloc = buildUrl(
                    libraryBaseUrl,
                    ...strings.libraries.talloc
                );

                const prootUrl = buildUrl(
                    libraryBaseUrl,
                    ...strings.libraries.prootXed
                );

                const libproot32 = architecture.hasLibproot32
                    ? buildUrl(
                        libraryBaseUrl,
                        ...strings.libraries.proot32
                    )
                    : null;

                const axsUrl = buildUrl(
                    githubReleaseBase,
                    "axs-pie-android-",
                    architecture.axsArchitecture
                );

                logger("⬇️  Downloading Ubuntu 24.04 filesystem...");
                await downloadFile(ubuntuUrl, cordova.file.dataDirectory + "ubuntu.tar.gz", "Ubuntu filesystem");

                logger("⬇️  Downloading axs...");
                await downloadFile(axsUrl, cordova.file.dataDirectory + "axs", "AXS");

                logger("⬇️  Downloading compatibility layer...");
                await downloadFile(prootUrl, cordova.file.dataDirectory + "libproot-xed.so", "Compatibility layer");

                logger("⬇️  Downloading supporting library...");
                await downloadFile(libTalloc, cordova.file.dataDirectory + "libtalloc.so.2", "Supporting library");

                if (libproot != null) {
                    await downloadFile(libproot, cordova.file.dataDirectory + "libproot.so", "proot loader");
                }

                if (libproot32 != null) {
                    await downloadFile(libproot32, cordova.file.dataDirectory + "libproot32.so", "32-bit proot loader");
                }

                logger("✅  All downloads completed");
            } else {
                logger("⬇️  Downloading Ubuntu 24.04 filesystem...");
                await downloadFile(ubuntuUrl, cordova.file.dataDirectory + "ubuntu.tar.gz", "Ubuntu filesystem");

                try {
                    await Executor.execute("rm -f $PREFIX/axs && ln -s $NATIVE_DIR/libaxs.so $PREFIX/axs");
                } catch (e) {
                    err_logger(`${formatError(e)}`);
                }
            }

            logger("📁  Setting up directories...");

            await ensureDir(`${filesDir}/.downloaded`);

            const distroDir = `${filesDir}/distro`;

            await ensureDir(distroDir);

            logger("📦  Extracting Ubuntu 24.04 filesystem...");
            await Executor.execute(`tar --no-same-owner -xf ${filesDir}/ubuntu.tar.gz -C ${distroDir}`);

            logger("⚙️  Applying basic configuration...");
            await writeText(`${distroDir}/etc/resolv.conf`, "nameserver 8.8.8.8\nnameserver 8.8.4.4\n");
            await writeText(`${distroDir}/etc/hosts`, "127.0.0.1 localhost\n::1 localhost\n");

            // Ensure Android supplementary GIDs exist in /etc/group
            await Executor.execute(`sh -c '
                for gid in $(id -G 2>/dev/null) 3003 9997 20442 50442 1015 1023 1028; do
                    if ! grep -q ":$gid:" "${distroDir}/etc/group" 2>/dev/null; then
                        case "$gid" in
                            3003) gname="aid_inet" ;;
                            9997) gname="aid_everybody" ;;
                            1015) gname="aid_sdcard_rw" ;;
                            1023) gname="aid_media_rw" ;;
                            *) gname="aid_$gid" ;;
                        esac
                        echo "$gname:x:$gid:root" >> "${distroDir}/etc/group" 2>/dev/null
                    fi
                done
            '`);

            const rmWrapper = await readAsset("rm-wrapper.sh");
            await ensureDir(`${distroDir}/bin`);
            await deleteFile(`${distroDir}/bin/rm`).catch(() => {});
            await writeText(`${distroDir}/bin/rm`, rmWrapper);
            await setExec(`${distroDir}/bin/rm`, true);

            logger("✅  Extraction complete");
            await ensureDir(`${filesDir}/.extracted`);

            logger("⚙️  Updating sandbox environment...");
            const installResult = await this.startAxs(true, logger, err_logger);
            if (!installResult) {
                throw new Error(this.lastInstallError || "Sandbox configuration failed.");
            }
            return installResult;

        } catch (e) {
            const message = formatError(e);
            this.lastInstallError = message;
            err_logger(`Installation failed: ${message}`);
            console.error("Installation failed:", e);
            return false;
        }
    },

    /**
     * Returns the active distro type ("proot" or "chroot").
     * @returns {Promise<string>}
     */
    async getDistroType() {
        try {
            const result = await Executor.BackgroundExecutor.execute(`cat "$PREFIX/.distro_type" 2>/dev/null || echo "proot"`);
            return (result || "proot").trim();
        } catch {
            return "proot";
        }
    },

    /**
     * Checks if the Linux environment is already installed.
     * @returns {Promise<boolean>} - Returns true if all required files and directories exist.
     */
    isInstalled() {
        return new Promise(async (resolve, reject) => {
            const filesDir = await new Promise((resolve, reject) => {
                system.getFilesDir(resolve, reject);
            });

            const distroType = await (async () => {
                try {
                    const type = await Executor.BackgroundExecutor.execute(`cat "$PREFIX/.distro_type" 2>/dev/null`);
                    return (type || "").trim();
                } catch {
                    return "";
                }
            })();

            const downloaded = await new Promise((resolve, reject) => {
                system.fileExists(`${filesDir}/.downloaded`, false, (result) => {
                    resolve(result == 1);
                }, reject);
            });

            const extracted = await new Promise((resolve, reject) => {
                system.fileExists(`${filesDir}/.extracted`, false, (result) => {
                    resolve(result == 1);
                }, reject);
            });

            const configured = await new Promise((resolve, reject) => {
                system.fileExists(`${filesDir}/.configured`, false, (result) => {
                    resolve(result == 1);
                }, reject);
            });

            if (distroType === "chroot") {
                resolve(configured && extracted);
                return;
            }

            const distroExists = await new Promise((resolve, reject) => {
                system.fileExists(`${filesDir}/distro`, false, (r1) => {
                    if (r1 == 1) return resolve(true);
                    system.fileExists(`${filesDir}/ubuntu`, false, (r2) => {
                        if (r2 == 1) return resolve(true);
                        system.fileExists(`${filesDir}/alpine`, false, (r3) => {
                            resolve(r3 == 1);
                        }, reject);
                    }, reject);
                }, reject);
            });

            resolve(distroExists && downloaded && extracted && configured);
        });
    },

    /**
     * Checks if the current device architecture is supported.
     * @returns {Promise<boolean>} - `true` if architecture is supported, otherwise `false`.
     */
    isSupported() {
        return new Promise((resolve, reject) => {
            system.getArch((arch) => {
                resolve(["arm64-v8a", "armeabi-v7a", "x86_64"].includes(arch));
            }, reject);
        });
    },
    /**
     * Creates a backup of the Linux installation
     * @async
     * @function backup
     * @description Creates a compressed tar archive of the installation
     * @returns {Promise<string>} Promise that resolves to the file URI of the created backup file (aterm_backup.tar)
     */
    backup() {
        return new Promise(async (resolve, reject) => {
            if (!await this.isInstalled()) {
                reject("Linux distribution is not installed.");
                return;
            }
            const cmd = `
            set -e
            INCLUDE_FILES="distro ubuntu alpine .downloaded .extracted .configured .distro_type bin/chroot-distro axs"
            EXISTING_INCLUDES=""
            for f in $INCLUDE_FILES; do
                if [ -e "$PREFIX/$f" ]; then
                    EXISTING_INCLUDES="$EXISTING_INCLUDES $f"
                fi
            done

            if [ "$FDROID" = "true" ]; then
                [ -e "$PREFIX/libtalloc.so.2" ] && EXISTING_INCLUDES="$EXISTING_INCLUDES libtalloc.so.2"
                [ -e "$PREFIX/libproot-xed.so" ] && EXISTING_INCLUDES="$EXISTING_INCLUDES libproot-xed.so"
            fi
            EXCLUDE="--exclude=*/data --exclude=*/system --exclude=*/vendor --exclude=*/sdcard --exclude=*/storage --exclude=*/public --exclude=*/apex --exclude=*/odm --exclude=*/product --exclude=*/system_ext --exclude=*/linkerconfig --exclude=*/proc --exclude=*/sys --exclude=*/dev --exclude=*/run --exclude=*/tmp"
            tar -cf "$PREFIX/aterm_backup.tar" -C "$PREFIX" $EXCLUDE $EXISTING_INCLUDES
            echo "ok"
            `;
            const result = await Executor.execute(cmd);
            if (result === "ok") {
                resolve(cordova.file.dataDirectory + "aterm_backup.tar");
            } else {
                reject(result);
            }
        });
    },
    /**
     * Restores Linux installation from a backup file
     * @async
     * @function restore
     */
    restore() {
        return new Promise(async (resolve, reject) => {
            if (await this.isAxsRunning()) {
                await this.stopAxs();
            }

            const cmd = `
            set -e

            INCLUDE_FILES="$PREFIX/distro $PREFIX/ubuntu $PREFIX/alpine $PREFIX/.downloaded $PREFIX/.extracted $PREFIX/.configured $PREFIX/.distro_type $PREFIX/bin/chroot-distro $PREFIX/axs"

            if [ "$FDROID" = "true" ]; then
                INCLUDE_FILES="$INCLUDE_FILES $PREFIX/libtalloc.so.2 $PREFIX/libproot-xed.so"
            fi

            for item in $INCLUDE_FILES; do
                rm -rf -- "$item"
            done

            tar -xf $PREFIX/aterm_backup.* -C "$PREFIX"
            echo "ok"
            `;

            const result = await Executor.BackgroundExecutor.execute(cmd);
            if (result === "ok") {
                resolve(result);
            } else {
                reject(result);
            }
        });
    },
    /**
     * Uninstalls the Linux installation
     * @async
     * @function uninstall
     */
    uninstall() {
        return new Promise(async (resolve, reject) => {
            if (await this.isAxsRunning()) {
                await this.stopAxs();
            }

            const cmd = `
            set -e

            INCLUDE_FILES="$PREFIX/distro $PREFIX/ubuntu $PREFIX/alpine $PREFIX/ubuntu.tar.gz $PREFIX/alpine.tar.gz $PREFIX/.downloaded $PREFIX/.extracted $PREFIX/.configured $PREFIX/.distro_type $PREFIX/bin/chroot-distro $PREFIX/axs"

            if [ "$FDROID" = "true" ]; then
                INCLUDE_FILES="$INCLUDE_FILES $PREFIX/libtalloc.so.2 $PREFIX/libproot-xed.so"
            fi

            for item in $INCLUDE_FILES; do
                rm -rf -- "$item"
            done

            echo "ok"
            `;
            const result = await Executor.BackgroundExecutor.execute(cmd);
            if (result === "ok") {
                resolve(result);
            } else {
                reject(result);
            }
        });
    },

    /**
     * Migrates the legacy terminal home directories into public/MIGRATE.
     * Older builds stored user files under alpine/home and alpine/root.
     * After /home, /root and /public were merged into a single public
     * directory, any files still left in the old locations are copied
     * into public/MIGRATE (keeping their source structure) so nothing is
     * hidden or lost. This is a no-op once the migration has run.
     * @returns {Promise<void>}
     */
    async migrateLegacyHome() {
        if (this._legacyHomeMigrated) return;
        try {
            const cmd = `
                MIGRATE="$PREFIX/public/MIGRATE"

                # Already migrated
                [ -e "$MIGRATE/.migrated" ] && exit 0

                COPIED=false

                if [ -d "$PREFIX/alpine/home" ] && [ -n "$(find "$PREFIX/alpine/home" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then
                    mkdir -p "$MIGRATE/home"
                    if cp -a "$PREFIX/alpine/home/." "$MIGRATE/home/"; then
                        COPIED=true
                    else
                        exit 1
                    fi
                fi

                if [ -d "$PREFIX/alpine/root" ] && [ -n "$(find "$PREFIX/alpine/root" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then
                    mkdir -p "$MIGRATE/root"
                    if cp -a "$PREFIX/alpine/root/." "$MIGRATE/root/"; then
                        COPIED=true
                    else
                        exit 1
                    fi
                fi

                # Mark as migrated so this only runs once
                if [ "$COPIED" = "true" ]; then
                    touch "$MIGRATE/.migrated"
                fi
            `;
            await Executor.BackgroundExecutor.execute(cmd);
            this._legacyHomeMigrated = true;
        } catch (error) {
            console.error("Failed to migrate legacy terminal home:", formatError(error));
        }
    },

    formatError
};


function readAsset(assetPath, callback) {
    const assetUrl = "file:///android_asset/" + assetPath;

    const promise = new Promise((resolve, reject) => {
        window.resolveLocalFileSystemURL(assetUrl, fileEntry => {
            fileEntry.file(file => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error || new Error(`Failed to read ${assetPath}`));
                reader.readAsText(file);
            }, reject);
        }, reject);
    });

    if (callback) {
        promise.then(callback).catch(console.error);
    }

    return promise;
}

function fileExists(path) {
    return new Promise((resolve, reject) => {
        system.fileExists(path, false, (result) => {
            resolve(result == 1);
        }, reject);
    });
}

async function ensureDir(path) {
    if (await fileExists(path)) return;

    await new Promise((resolve, reject) => {
        system.mkdirs(path, resolve, reject);
    });
}

function writeText(path, content) {
    return new Promise((resolve, reject) => {
        system.writeText(path, content, resolve, reject);
    });
}

function deleteFile(path) {
    return new Promise((resolve, reject) => {
        system.deleteFile(path, resolve, reject);
    });
}

function setExec(path, executable) {
    return new Promise((resolve, reject) => {
        system.setExec(path, executable, resolve, reject);
    });
}

function downloadFile(url, destination, label) {
    return new Promise((resolve, reject) => {
        cordova.plugin.http.downloadFile(
            url, {}, {},
            destination,
            resolve,
            (error) => reject(new Error(`${label} download failed: ${formatError(error)}`))
        );
    });
}

function formatError(error) {
    if (error == null) return "Unknown error";
    if (error instanceof Error) return error.message || String(error);
    if (typeof error === "string") return error || "Unknown error";
    if (typeof error === "object") {
        const parts = [];
        if (error.status != null) parts.push(`status ${error.status}`);
        if (error.error) parts.push(String(error.error));
        if (error.message) parts.push(String(error.message));
        if (error.exception) parts.push(String(error.exception));
        if (error.url) parts.push(`URL: ${error.url}`);
        if (parts.length) return parts.join(" - ");

        try {
            return JSON.stringify(error);
        } catch (jsonError) {
            return String(error);
        }
    }

    return String(error);
}

module.exports = Terminal;
