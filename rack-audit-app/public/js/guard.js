// Warns before the agent leaves mid-visit (back button, tab close, or
// refresh) since some progress could be lost. Standard SPA pattern: push a
// sentinel history entry, and if the user tries to go back, re-push it and
// ask for confirmation before actually letting them leave.
let active = false;

function onPopState() {
  if (!active) return;
  history.pushState(null, "", location.href); // neutralize the back nav visually
  const leave = confirm("Leaving now may lose progress on this visit. Continue anyway?");
  if (leave) {
    NavGuard.disable();
    history.back(); // now actually go back, unguarded
  }
}

function onBeforeUnload(e) {
  if (!active) return;
  e.preventDefault();
  // Modern browsers ignore this string and show their own generic message —
  // setting returnValue is still required to trigger the native prompt at all.
  e.returnValue = "";
}

export const NavGuard = {
  enable() {
    if (active) return;
    active = true;
    history.pushState(null, "", location.href);
    window.addEventListener("popstate", onPopState);
    window.addEventListener("beforeunload", onBeforeUnload);
  },
  disable() {
    if (!active) return;
    active = false;
    window.removeEventListener("popstate", onPopState);
    window.removeEventListener("beforeunload", onBeforeUnload);
  },
};
