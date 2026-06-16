/* Pre-paint theme bootstrap. Loaded as an external, blocking script in <head>
   (CSP: script-src 'self') so the correct light/dark surface is applied BEFORE
   Vue mounts — no flash of the wrong theme. Brand palette is applied by the
   theme store after mount (a brief accent settle is acceptable). */
(function () {
  try {
    var KEY = "lattice.theme"; // "light" | "dark" | "system"
    var mode = localStorage.getItem(KEY) || "system";
    var prefersDark =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    var dark = mode === "dark" || (mode === "system" && prefersDark);

    var root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#1b1b29" : "#ffffff");

    window.__LATTICE_THEME__ = { mode: mode, dark: dark };
  } catch (e) {
    /* localStorage may be unavailable; default markup is dark. */
  }
})();
