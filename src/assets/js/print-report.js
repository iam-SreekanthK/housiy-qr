/* CSP-safe print button for exported reports (no inline handlers). */
document.querySelectorAll('[data-print]').forEach((btn) => {
  btn.addEventListener('click', () => window.print());
});
