import "./style.scss";
import Sidebar from "components/sidebar";
import toast from "components/toast";
import confirm from "dialogs/confirm";
import select from "dialogs/select";
import fsOperation from "fileSystem";
import openFile from "lib/openFile";
import openFolder from "lib/openFolder";
import helpers from "utils/helpers";
import mimeTypes from "mime-types";
import Url from "utils/Url";

/** @type {HTMLElement} */
let container = null;
/** @type {HTMLElement} */
let $downloadsList = null;

let isScanning = false;

export default [
	"folder-download", // icon
	"downloads", // id
	strings["downloads"] || "Downloads", // title
	initApp, // init function
	false, // prepend
	onSelected, // onSelected function
];

const $header = (
	<div className="header">
		<div className="title">
			<span>{strings["downloads"] || "Downloads"}</span>
			<div className="actions">
				<button
					type="button"
					className="icon-button"
					title={strings["open folder"] || "Open Folder"}
					onclick={openDownloadsInTree}
				>
					<span className="icon folder"></span>
				</button>
				<button
					type="button"
					className="icon-button"
					title={strings["refresh"] || "Refresh"}
					onclick={loadDownloads}
				>
					<span className="icon refresh"></span>
				</button>
			</div>
		</div>
	</div>
);

/**
 * Initialize downloads app
 * @param {HTMLElement} el
 */
function initApp(el) {
	container = el;
	container.classList.add("downloads");
	container.content = $header;

	$downloadsList = <div className="downloads-container scroll"></div>;
	container.append($downloadsList);

	Sidebar.on("show", onSelected);
}

/**
 * On selected handler
 * @param {HTMLElement} el
 */
function onSelected(el) {
	loadDownloads();
}

/**
 * Open downloads folder in Acode folder tree
 */
async function openDownloadsInTree() {
	try {
		const downloadDir = getDownloadDirectoryUrl();
		if (downloadDir) {
			openFolder(downloadDir, { name: "Downloads" });
			toast(strings["success"] || "Success");
		}
	} catch (e) {
		console.error("Failed to open downloads folder:", e);
		toast(strings["error"] || "Error");
	}
}

/**
 * Returns the download directory URL
 * @returns {string}
 */
function getDownloadDirectoryUrl() {
	if (window.cordova?.file?.externalRootDirectory) {
		return Url.join(window.cordova.file.externalRootDirectory, "Download");
	}
	return "file:///sdcard/Download";
}

/**
 * Format bytes to readable string
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
	if (!bytes || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	let i = 0;
	let size = bytes;
	while (size >= 1024 && i < units.length - 1) {
		size /= 1024;
		i++;
	}
	return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Scan and load downloads
 */
async function loadDownloads() {
	if (isScanning || !$downloadsList) return;
	isScanning = true;

	try {
		$downloadsList.innerHTML = "";
		const downloadDir = getDownloadDirectoryUrl();
		const fs = fsOperation(downloadDir);

		let entries = [];
		try {
			if (await fs.exists()) {
				entries = await fs.lsDir();
			}
		} catch (e) {
			console.warn("Could not read downloads directory directly:", e);
		}

		// Filter files and sort by modification date if available
		const files = entries.filter((e) => !e.isDirectory);

		if (files.length === 0) {
			renderEmptyState();
			return;
		}

		// Sort newest first
		files.sort((a, b) => {
			const aTime = a.lastModified || a.mtime || 0;
			const bTime = b.lastModified || b.mtime || 0;
			return bTime - aTime;
		});

		for (const file of files) {
			const $item = createDownloadItem(file);
			$downloadsList.append($item);
		}
	} catch (err) {
		console.error("Failed to load downloads:", err);
		renderEmptyState();
	} finally {
		isScanning = false;
	}
}

/**
 * Render empty state
 */
function renderEmptyState() {
	if (!$downloadsList) return;
	$downloadsList.innerHTML = "";

	const $empty = (
		<div className="empty-state">
			<span className="icon folder-download empty-icon"></span>
			<div className="empty-text">
				{strings["no files"] || "No downloaded files found"}
			</div>
			<button
				type="button"
				className="empty-btn"
				onclick={() => {
					import("plugins/browser").then(({ default: browser }) => {
						browser.open("https://github.com");
					});
				}}
			>
				<span className="icon github"></span>
				<span>Open GitHub</span>
			</button>
		</div>
	);

	$downloadsList.append($empty);
}

/**
 * Create a single download list item
 * @param {object} file
 * @returns {HTMLElement}
 */
function createDownloadItem(file) {
	const name = file.name || Url.basename(file.url);
	const iconClass = helpers.getIconForFile(name);
	const sizeText = file.length ? formatSize(file.length) : "";
	const isApk = name.toLowerCase().endsWith(".apk");

	const $item = (
		<div
			className="download-item"
			onclick={(e) => {
				if (e.target.closest(".action-btn")) return;
				handleFileClick(file);
			}}
		>
			<div className="item-icon">
				<span className={iconClass}></span>
			</div>
			<div className="item-details">
				<div className="item-name" title={name}>
					{name}
				</div>
				<div className="item-meta">{sizeText || (isApk ? "Android Package" : "File")}</div>
			</div>
			<div className="item-actions">
				<button
					type="button"
					className="action-btn"
					title={strings["open with"] || "Open with..."}
					onclick={() => openWithSystem(file)}
				>
					<span className="icon open_with"></span>
				</button>
				<button
					type="button"
					className="action-btn"
					title={strings["delete"] || "Delete"}
					onclick={() => deleteDownloadedFile(file)}
				>
					<span className="icon delete"></span>
				</button>
			</div>
		</div>
	);

	return $item;
}

/**
 * Handle clicking on a downloaded file
 * @param {object} file
 */
async function handleFileClick(file) {
	const name = file.name || Url.basename(file.url);
	const isApk = name.toLowerCase().endsWith(".apk");

	if (isApk) {
		openWithSystem(file);
		return;
	}

	try {
		await openFile(file.url);
		Sidebar.hide();
	} catch (e) {
		openWithSystem(file);
	}
}

/**
 * Open file with Android system / external app
 * @param {object} file
 */
async function openWithSystem(file) {
	const name = file.name || Url.basename(file.url);
	const mimeType =
		mimeTypes.lookup(name) ||
		(name.toLowerCase().endsWith(".apk")
			? "application/vnd.android.package-archive"
			: "application/octet-stream");

	try {
		if (window.system?.fileAction) {
			window.system.fileAction(file.url, name, "VIEW", mimeType, () => {
				toast(strings["no app found to handle this file"] || "Cannot open file");
			});
		} else if (window.system?.openInBrowser) {
			window.system.openInBrowser(file.url);
		}
	} catch (err) {
		console.error("Failed to open with system:", err);
		toast(strings["error"] || "Error");
	}
}

/**
 * Delete downloaded file
 * @param {object} file
 */
async function deleteDownloadedFile(file) {
	const name = file.name || Url.basename(file.url);
	const confirmation = await confirm(
		strings["warning"] || "Warning",
		(strings["delete entry"] || "Delete {name}?").replace("{name}", name),
	);

	if (!confirmation) return;

	try {
		await fsOperation(file.url).delete();
		toast(strings["success"] || "Deleted");
		loadDownloads();
	} catch (e) {
		console.error("Failed to delete download:", e);
		toast(strings["error"] || "Failed to delete");
	}
}
