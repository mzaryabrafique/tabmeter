const STORAGE_STATS = "stats";
const STORAGE_LIMITS = "siteLimits";
const STORAGE_VIEW_MODE = "viewMode";
const STORAGE_IDLE_TIMEOUT = "idleTimeout";

const idleTimeoutSelect = document.getElementById('idle-timeout-select');
const viewModeSelect = document.getElementById('view-mode-select');
const exportDataBtn = document.getElementById('export-data-btn');
const clearDataBtn = document.getElementById('clear-data-btn');
const toastContainer = document.getElementById('toast-container');

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => {
      toast.remove();
    }, 200);
  }, 3000);
}

// Load settings
async function loadSettings() {
  const data = await chrome.storage.local.get([STORAGE_VIEW_MODE, STORAGE_IDLE_TIMEOUT]);
  
  if (data[STORAGE_VIEW_MODE]) {
    viewModeSelect.value = data[STORAGE_VIEW_MODE];
  } else {
    viewModeSelect.value = 'popup';
  }

  if (data[STORAGE_IDLE_TIMEOUT]) {
    idleTimeoutSelect.value = data[STORAGE_IDLE_TIMEOUT].toString();
  } else {
    idleTimeoutSelect.value = '60';
  }
}

// Save View Mode
viewModeSelect.addEventListener('change', async (e) => {
  const mode = e.target.value;
  await chrome.storage.local.set({ [STORAGE_VIEW_MODE]: mode });
  
  // Re-apply immediately
  if (mode === "side_panel") {
    await chrome.action.setPopup({ popup: "" });
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } else {
    await chrome.action.setPopup({ popup: "popup.html" });
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    }
  }
  showToast("View mode updated");
});

// Save Idle Timeout
idleTimeoutSelect.addEventListener('change', async (e) => {
  const timeout = parseInt(e.target.value, 10);
  await chrome.storage.local.set({ [STORAGE_IDLE_TIMEOUT]: timeout });
  
  // Inform chrome idle API
  chrome.idle.setDetectionInterval(timeout);
  showToast("Idle timeout updated");
});

// Export Data
exportDataBtn.addEventListener('click', async () => {
  try {
    const data = await chrome.storage.local.get([STORAGE_STATS, STORAGE_LIMITS]);
    const exportObj = {
      exportedAt: new Date().toISOString(),
      version: "1.1.0",
      data: data
    };
    
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `tabmeter-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
    showToast("Data exported successfully");
  } catch (err) {
    console.error("Export failed:", err);
    showToast("Export failed");
  }
});

// Clear Data
clearDataBtn.addEventListener('click', async () => {
  const confirmDelete = confirm("Are you sure you want to delete all your tracked time and site limits? This action cannot be undone.");
  if (confirmDelete) {
    await chrome.storage.local.remove([STORAGE_STATS, STORAGE_LIMITS]);
    showToast("All data cleared successfully");
  }
});

// Init
document.addEventListener('DOMContentLoaded', loadSettings);
