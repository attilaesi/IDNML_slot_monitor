document.addEventListener("DOMContentLoaded", () => {
    const toggleButton = document.getElementById("toggleMonitor");

    // Load and set the button state on popup open
    chrome.storage.local.get(["monitorEnabled"], (result) => {
        const isEnabled = result.monitorEnabled || false;
        updateButtonText(isEnabled);
    });

    toggleButton.addEventListener("click", () => {
        chrome.storage.local.get(["monitorEnabled"], (result) => {
            const isEnabled = result.monitorEnabled || false;
            const newState = !isEnabled;

            chrome.storage.local.set({ monitorEnabled: newState }, () => {
                updateButtonText(newState);

                chrome.runtime.sendMessage({ action: "toggleMonitor", enabled: newState });
            });
        });
    });

    function updateButtonText(isEnabled) {
        toggleButton.textContent = isEnabled ? "Disable Ad Monitor" : "Enable Ad Monitor";
    }
});