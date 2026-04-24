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
});
