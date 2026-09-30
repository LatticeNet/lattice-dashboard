try {
  if (!localStorage.getItem("lattice.theme")) localStorage.setItem("lattice.theme", "system");
} catch (e) {
  /* storage may be unavailable; theme-init falls back to dark */
}
