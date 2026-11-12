// Runs before first paint (classic, non-module script) so the page never
// flashes the wrong theme. Follows the device's light/dark setting and
// switches Bootstrap's own colour mode, so every component is themed.
(function () {
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  function apply() {
    var dark = media.matches;
    document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (meta) meta.setAttribute('content', dark ? '#0a1329' : '#0d6efd');
  }
  apply();
  if (media.addEventListener) media.addEventListener('change', apply); else media.addListener(apply);
}());
