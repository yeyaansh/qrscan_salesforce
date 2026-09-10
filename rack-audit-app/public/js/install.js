// PWA install prompt. Android/Chrome fires `beforeinstallprompt`, which we
// capture and trigger from our own button. iOS Safari never fires that
// event at all (Apple's choice) — there's no programmatic install API, so
// iOS gets instructions instead ("Share -> Add to Home Screen").
let deferredPrompt = null;

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export const InstallPrompt = {
  init({ banner, copy, installBtn, dismissBtn }) {
    if (isStandalone()) return; // already installed — nothing to show

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      copy.textContent = "Install this app for quicker access and a full-screen view.";
      banner.classList.add("show");
    });

    if (isIOS()) {
      copy.textContent = 'Install this app: tap the Share icon, then "Add to Home Screen."';
      installBtn.style.display = "none"; // no programmatic prompt on iOS — instructional only
      banner.classList.add("show");
    }

    installBtn.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      banner.classList.remove("show");
    });

    dismissBtn.addEventListener("click", () => banner.classList.remove("show"));
    window.addEventListener("appinstalled", () => banner.classList.remove("show"));
  },
};
