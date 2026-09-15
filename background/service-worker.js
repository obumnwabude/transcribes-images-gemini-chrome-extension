// Background Service Worker for Gemini Image Transcriber (MV3)

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("[Transcriber SW] Error setting panel behavior:", error));

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Transcriber SW] Extension installed successfully.");
});
