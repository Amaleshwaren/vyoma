// the title screen: New game zooms into Mars, then the lander's cockpit (the sector picker) fades in.
// the zoom is pure CSS (see #title-screen.zooming in styles.css); this file only times the hand-over.
const $ = (id) => document.getElementById(id);

const ZOOM_MS = 1100; // keep in step with the .title-bg transition in styles.css

export function initMenu() {
  const title = $('title-screen');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function openPicker() {
    title.classList.add('hidden');
    title.classList.remove('zooming');
    $('sector-picker').classList.remove('hidden');
  }

  $('new-game-btn').addEventListener('click', () => {
    if (title.classList.contains('zooming')) return; // ignore double taps mid-zoom
    if (reduceMotion) return openPicker();
    title.classList.add('zooming');
    setTimeout(openPicker, ZOOM_MS);
  });
}
