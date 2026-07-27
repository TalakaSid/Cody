import { initScrubber } from './scrubber.js';
import { initReveals } from './reveals.js';

const root = document.documentElement;
const preloader = document.getElementById('preloader');
const fill = preloader.querySelector('.preloader__fill');
const pct = preloader.querySelector('.preloader__pct');

root.classList.add('is-loading');

initReveals(); // independent of frame loading — sections can animate once scroll unlocks

function setProgress(p) {
  fill.style.strokeDashoffset = String(283 - 283 * p);
  pct.textContent = `${Math.round(p * 100)}%`;
}

// Under reduced-motion or a metered connection, skip the sharp ring entirely and
// run proxy-only — smaller, instant, and the site still fully works.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const saveData = navigator.connection?.saveData === true;
const slowConnection = /2g/.test(navigator.connection?.effectiveType || '');

let lenis; // assigned synchronously below; onReady only fires later, asynchronously
lenis = initScrubber({
  proxyOnly: reduceMotion || saveData || slowConnection,
  // The proxy spine is the primary gate (0-70%): once it's in, every scroll
  // position has something correct to show, even if the sharp ring is empty.
  onSpineProgress: (loaded, total) => setProgress((loaded / total) * 0.7),
  // The initial sharp window (70-100%) is best-effort polish, not a blocker —
  // it has its own internal timeout, so this never meaningfully stalls launch.
  onWindowProgress: (loaded, total) => setProgress(0.7 + (loaded / total) * 0.3),
  onReady: () => {
    setProgress(1);
    preloader.classList.add('is-done');
    root.classList.remove('is-loading');
    lenis.start();
    preloader.addEventListener('transitionend', () => preloader.remove(), { once: true });
  },
});
