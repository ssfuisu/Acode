// Auto-update release details from GitHub API
const REPO_OWNER = "ssfuisu";
const REPO_NAME = "Acode";
const FALLBACK_APK_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/latest-release/Acode-Ubuntu24-Release.apk`;

async function fetchLatestRelease() {
  const relTag = document.getElementById("rel-tag");
  const relName = document.getElementById("rel-name");
  const relMeta = document.getElementById("rel-meta");
  const directLink = document.getElementById("direct-apk-link");
  const heroDownloadBtn = document.getElementById("hero-download-btn");
  const heroVersionText = document.getElementById("hero-version-text");
  const apkSizeLabel = document.getElementById("apk-size-label");

  try {
    const response = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`);
    if (!response.ok) throw new Error("Release API response not ok");

    const data = await response.json();
    const tag = data.tag_name || "latest-release";
    const name = data.name || "Acode Ubuntu 24.04 Release";
    const publishedAt = data.published_at ? new Date(data.published_at).toLocaleDateString("en-US", { year: 'numeric', month: 'short', day: 'numeric' }) : "Recently updated";

    let apkAsset = null;
    if (data.assets && data.assets.length > 0) {
      apkAsset = data.assets.find(a => a.name.endsWith(".apk")) || data.assets[0];
    }

    const downloadUrl = apkAsset ? apkAsset.browser_download_url : FALLBACK_APK_URL;
    let sizeText = "Single-file APK (~32 MB)";

    if (apkAsset && apkAsset.size) {
      const mb = (apkAsset.size / (1024 * 1024)).toFixed(2);
      sizeText = `Direct APK (${mb} MB)`;
    }

    // Update UI elements
    if (relTag) relTag.textContent = `${tag.toUpperCase()} • STABLE`;
    if (relName) relName.textContent = name;
    if (relMeta) relMeta.textContent = `Published on ${publishedAt} • Continuous Delivery`;
    if (directLink) directLink.href = downloadUrl;
    if (heroDownloadBtn) heroDownloadBtn.href = downloadUrl;
    if (heroVersionText) heroVersionText.textContent = tag;
    if (apkSizeLabel) apkSizeLabel.textContent = sizeText;

  } catch (err) {
    console.warn("Could not fetch release dynamically, falling back to static URL:", err);
    if (directLink) directLink.href = FALLBACK_APK_URL;
    if (heroDownloadBtn) heroDownloadBtn.href = FALLBACK_APK_URL;
    if (relMeta) relMeta.textContent = "Latest build from GitHub Releases";
    if (apkSizeLabel) apkSizeLabel.textContent = "Single-file (~32 MB)";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  fetchLatestRelease();
});
