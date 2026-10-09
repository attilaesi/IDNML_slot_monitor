// Runs each time DevTools opens; panels can't be removed later, so the tick box applies on the next open
loadSettings((settings) => {
    if (settings.views.devtools) chrome.devtools.panels.create("Slot Monitor", "icon.png", "panel.html?mode=devtools");
});
