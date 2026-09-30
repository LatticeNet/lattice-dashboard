try {
  var theme = new URLSearchParams(location.search).get("theme");
  if (theme === "light" || theme === "dark") localStorage.setItem("lattice.theme", theme);
} catch (e) {
  /* storage may be unavailable; theme-init falls back to dark */
}
