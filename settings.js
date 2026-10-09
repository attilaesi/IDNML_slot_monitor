// Settings shared by the popup, background, content script and monitor pages
const DEFAULT_VIEWS = { overlay: true, sidePanel: false, window: false, devtools: false };
const OVERLAY_POSITIONS = ["top", "right", "bottom", "left"];

function loadSettings(callback) {
    chrome.storage.local.get(["monitorEnabled", "views", "overlayPosition"], (result) => {
        callback({
            monitorEnabled: !!result.monitorEnabled,
            views: { ...DEFAULT_VIEWS, ...result.views },
            overlayPosition: OVERLAY_POSITIONS.includes(result.overlayPosition) ? result.overlayPosition : "top",
        });
    });
}
