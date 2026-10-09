// Read up front: sidePanel.open must run straight inside the click, with no await before it
let currentWindowId = null;
chrome.windows.getCurrent((win) => { currentWindowId = win.id; });

const enabledBox = document.getElementById("monitorEnabled");
const viewBoxes = document.querySelectorAll("[data-view]");
const positionSelect = document.getElementById("overlayPosition");

loadSettings((settings) => {
    enabledBox.checked = settings.monitorEnabled;
    viewBoxes.forEach((box) => { box.checked = settings.views[box.dataset.view]; });
    positionSelect.value = settings.overlayPosition;
});

positionSelect.addEventListener("change", () => {
    chrome.storage.local.set({ overlayPosition: positionSelect.value });
});

enabledBox.addEventListener("change", () => {
    chrome.storage.local.set({ monitorEnabled: enabledBox.checked });
});

viewBoxes.forEach((box) => {
    box.addEventListener("change", () => {
        const view = box.dataset.view;
        const on = box.checked;

        if (view === "sidePanel") {
            chrome.sidePanel.setOptions({ enabled: on });
            if (on) chrome.sidePanel.open({ windowId: currentWindowId }).catch(console.error);
        } else if (view === "window") {
            // The background opens/closes it, since this popup closes as soon as the window takes focus
            chrome.runtime.sendMessage({ type: on ? "openMonitorWindow" : "closeMonitorWindow" });
        }

        loadSettings((settings) => {
            chrome.storage.local.set({ views: { ...settings.views, [view]: on } });
        });
    });
});
