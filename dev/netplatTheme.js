// ?theme=light|dark and ?lang=en|zh-CN for the netplat harness, applied
// before theme-init reads storage, so the first paint is already right.
try {
  var params = new URLSearchParams(location.search);
  var theme = params.get("theme");
  if (theme === "light" || theme === "dark") localStorage.setItem("lattice.theme", theme);
  var lang = params.get("lang");
  if (lang === "en" || lang === "zh-CN") localStorage.setItem("lattice.locale", lang);
  else localStorage.setItem("lattice.locale", "en");
} catch (e) {
  /* storage may be unavailable; the defaults apply */
}
