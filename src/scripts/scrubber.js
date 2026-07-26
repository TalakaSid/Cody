import Lenis from 'lenis';
import { tierFor, dprCapFor, createFrameEngine, drawFrame, applyCanvasSize } from './frame-engine.js';

// Paints via a Worker + OffscreenCanvas when the browser supports it, so canvas
// drawing never competes with the anime.js reveals (or anything else) for
// main-thread time. Falls back to painting directly on the main thread with
// the exact same frame-engine.js logic when it doesn't.
export function initScrubber({ proxyOnly, onSpineProgress, onWindowProgress, onReady }) {
  const canvas = document.getElementById('scrubber');
  let tier = tierFor(window.innerWidth);
  let dpr = Math.min(window.devicePixelRatio || 1, dprCapFor(tier.id));
  let vw = window.innerWidth;
  let vh = window.innerHeight;

  const supportsWorker = 'transferControlToOffscreen' in canvas && typeof OffscreenCanvas !== 'undefined';

  let worker = null;
  let fallback = null; // { engine, ctx, fadeState }

  function measure() {
    return { width: canvas.clientWidth || window.innerWidth, height: canvas.clientHeight || window.innerHeight };
  }

  if (supportsWorker) {
    worker = new Worker(new URL('./frame-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'spineProgress') onSpineProgress(msg.loaded, msg.total);
      else if (msg.type === 'windowProgress') onWindowProgress(msg.loaded, msg.total);
      else if (msg.type === 'ready') onReady();
    };
    const { width, height } = measure();
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: 'init', canvas: offscreen, width, height, dpr, tier, proxyOnly }, [offscreen]);
  } else {
    const ctx = canvas.getContext('2d', { alpha: false });
    const engine = createFrameEngine({ tier, proxyOnly });
    const fadeState = { lastKey: null, lastImg: null, lastDims: null, from: null, fromDims: null, startTs: 0 };
    fallback = { engine, ctx, fadeState };
    const { width, height } = measure();
    applyCanvasSize(canvas, ctx, width, height, dpr);
    engine
      .loadSpine((loaded, total) => onSpineProgress(loaded, total))
      .then(() => engine.primeWindow((loaded, total) => onWindowProgress(loaded, total)))
      .then(() => onReady());
  }

  function resize(entry) {
    let cssW, cssH;
    if (entry?.contentBoxSize) {
      const box = Array.isArray(entry.contentBoxSize) ? entry.contentBoxSize[0] : entry.contentBoxSize;
      cssW = box.inlineSize;
      cssH = box.blockSize;
    } else {
      const m = measure();
      cssW = m.width;
      cssH = m.height;
    }
    vw = cssW;
    vh = cssH;
    tier = tierFor(window.innerWidth);
    dpr = Math.min(window.devicePixelRatio || 1, dprCapFor(tier.id));

    if (worker) {
      worker.postMessage({ type: 'resize', width: cssW, height: cssH, dpr, tier });
    } else if (fallback) {
      applyCanvasSize(canvas, fallback.ctx, cssW, cssH, dpr);
      fallback.engine.setTier(tier);
    }
  }

  const ro = new ResizeObserver((entries) => resize(entries[0]));
  ro.observe(canvas);

  const lenis = new Lenis({ duration: 1.1, smoothWheel: true, touchMultiplier: 1.2 });
  lenis.stop(); // stays locked until the preloader calls .start()

  let lastTime = 0;
  function raf(time) {
    lenis.raf(time);
    const dt = lastTime ? (time - lastTime) / 1000 : 0;
    lastTime = time;
    const p = lenis.progress;

    if (worker) {
      worker.postMessage({ type: 'tick', p, dt });
    } else if (fallback) {
      fallback.engine.update(p, dt);
      drawFrame(fallback.ctx, vw, vh, fallback.engine.get(p), fallback.engine.velocity, fallback.fadeState);
    }
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);

  return lenis;
}
