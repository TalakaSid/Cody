// Runs off the main thread so canvas painting never competes with the
// anime.js reveal animations (or anything else on the page) for main-thread
// time — that contention was a real source of the "cutty" scroll feel.
import { createFrameEngine, drawFrame, applyCanvasSize } from './frame-engine.js';

let engine = null;
let canvas = null;
let ctx = null;
let vw = 0;
let vh = 0;
let dpr = 1;
let debug = false;
let lastDebugPost = 0;
const fadeState = { lastKey: null, lastImg: null, lastDims: null, from: null, fromDims: null, startTs: 0 };

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    canvas = msg.canvas;
    ctx = canvas.getContext('2d', { alpha: false });
    vw = msg.width;
    vh = msg.height;
    dpr = msg.dpr;
    applyCanvasSize(canvas, ctx, vw, vh, dpr);

    debug = !!msg.debug;
    engine = createFrameEngine({ tier: msg.tier, proxyOnly: msg.proxyOnly });
    engine
      .loadSpine((loaded, total) => postMessage({ type: 'spineProgress', loaded, total }))
      .then(() => engine.primeWindow((loaded, total) => postMessage({ type: 'windowProgress', loaded, total })))
      .then(() => postMessage({ type: 'ready' }));
    return;
  }

  if (!engine) return; // resize/tick arriving before init is done — ignore, next tick will catch up

  if (msg.type === 'resize') {
    vw = msg.width;
    vh = msg.height;
    dpr = msg.dpr;
    applyCanvasSize(canvas, ctx, vw, vh, dpr);
    engine.setTier(msg.tier);
    return;
  }

  if (msg.type === 'tick') {
    const t0 = debug ? performance.now() : 0;
    engine.update(msg.p, msg.dt);
    const frame = engine.get(msg.p);
    drawFrame(ctx, vw, vh, frame, engine.velocity, fadeState);
    if (debug) {
      const tickMs = performance.now() - t0;
      const now = performance.now();
      if (now - lastDebugPost > 400) {
        lastDebugPost = now;
        postMessage({ type: 'debug', tickMs: Math.round(tickMs), ...engine.debugInfo });
      }
    }
  }
};
