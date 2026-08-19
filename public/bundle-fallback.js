const CDN_BASE = "https://cdn.jsdelivr.net/gh/rameshxcb-stack/MCQ-STORE-@main/public/bundles";
const MANIFEST_TTL = 5 * 60 * 1000;
let manifestData = null, manifestFetchTime = 0, inFlightManifestPromise = null;

async function getManifest() {
  const now = Date.now();
  if (manifestData && (now - manifestFetchTime < MANIFEST_TTL)) return manifestData;
  if (inFlightManifestPromise) return inFlightManifestPromise;

  inFlightManifestPromise = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${CDN_BASE}/manifest.json?v=${now}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifestData = await res.json();
      manifestFetchTime = Date.now();
      return manifestData;
    } catch (error) {
      if (manifestData) { console.warn("Serving stale manifest:", error.message); return manifestData; }
      throw new Error(`Manifest Load Failed: ${error.message}`);
    } finally { inFlightManifestPromise = null; }
  })();
  return inFlightManifestPromise;
}

async function loadChapterFallback(currentChapter) {
  try {
    const manifest = await getManifest();
    const normalizedKey = String(currentChapter || "").trim().toLowerCase();
    const actualFileName = manifest[normalizedKey];
    if (!actualFileName) throw new Error(`Chapter "${currentChapter}" not found.`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const bundleRes = await fetch(`${CDN_BASE}/${actualFileName}`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!bundleRes.ok) throw new Error(`Bundle HTTP ${bundleRes.status}`);
    return await bundleRes.json();
  } catch (error) {
    console.error(`❌ Fallback Error [${currentChapter}]:`, error.message);
    return null;
  }
}
if (typeof window !== "undefined") window.loadChapterFallback = loadChapterFallback;
