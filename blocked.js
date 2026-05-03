document.addEventListener("DOMContentLoaded", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const hostParam = urlParams.get("host");
  
  if (hostParam) {
    const hostEl = document.getElementById("blocked-host");
    if (hostEl) {
      hostEl.textContent = hostParam;
    }
  }

  const closeBtn = document.getElementById("close-tab-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      // In extensions, we can only close tabs safely this way
      window.close();
    });
  }

  const removeLimitBtn = document.getElementById("remove-limit-btn");
  if (removeLimitBtn && hostParam) {
    removeLimitBtn.addEventListener("click", async () => {
      const STORAGE_LIMITS = "siteLimits";
      const { [STORAGE_LIMITS]: limits } = await chrome.storage.local.get(STORAGE_LIMITS);
      if (limits && typeof limits === "object" && limits[hostParam]) {
        delete limits[hostParam];
        await chrome.storage.local.set({ [STORAGE_LIMITS]: limits });
      }
      window.location.replace(`https://${hostParam}`);
    });
  }
});
