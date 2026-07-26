import Lenis from 'lenis';

const FADE_MS = 120;
const FADE_MAX_VELOCITY = 2; // frames/sec — only crossfade proxy->sharp near-stationary

function dprCapFor(tierId) {
  // Cap device-pixel scaling below the source's own resolution so we're not
  // spending fill-rate interpolating detail the frames don't have.
  return tierId === 'desktop' ? 1.3 : 1.15;
}

export function initScrubber(frameSource) {
  const canvas = document.getElementById('scrubber');
  const ctx = canvas.getContext('2d', { alpha: false });
  let vw = window.innerWidth;
  let vh = window.innerHeight;
  let dpr = 1;
  let lastProgress = 0;
  let lastDrawnKey = null;
  let lastImg = null;
  let lastDims = null;
  let fade = null; // { from, dims, startTs }

  function applyContextDefaults() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  }

  // ResizeObserver on the canvas element itself (not window.innerHeight) so we
  // measure the real laid-out box — this is what avoids the iOS `100vh` vs
  // `window.innerHeight` mismatch that stretches the backing bitmap.
  function resize(entry) {
    let cssW, cssH, pxW, pxH;
    if (entry?.contentBoxSize) {
      const box = Array.isArray(entry.contentBoxSize) ? entry.contentBoxSize[0] : entry.contentBoxSize;
      cssW = box.inlineSize;
      cssH = box.blockSize;
    } else {
      cssW = canvas.clientWidth;
      cssH = canvas.clientHeight;
    }
    vw = cssW;
    vh = cssH;
    dpr = Math.min(window.devicePixelRatio || 1, dprCapFor(frameSource.tier.id));
    pxW = Math.round(cssW * dpr);
    pxH = Math.round(cssH * dpr);
    if (entry?.devicePixelContentBoxSize) {
      const box = entry.devicePixelContentBoxSize[0];
      pxW = box.inlineSize;
      pxH = box.blockSize;
    }
    canvas.width = pxW;
    canvas.height = pxH;
    applyContextDefaults();
    lastDrawnKey = null;
    frameSource.checkTier();
    draw(lastProgress);
  }

  const ro = new ResizeObserver((entries) => resize(entries[0]));
  ro.observe(canvas);

  frameSource.onReady(() => {
    lastDrawnKey = null; // force the next tick to re-evaluate/redraw
  });

  function draw(p) {
    const { img, isSharp, index } = frameSource.get(p);
    if (!img || (!isSharp && !img.complete)) return;

    const { width: baseW, height: baseH } = frameSource.tier;
    const srcW = img.width || baseW;
    const srcH = img.height || baseH;
    const scale = Math.max(vw / srcW, vh / srcH);
    const dw = srcW * scale;
    const dh = srcH * scale;
    const dx = (vw - dw) / 2;
    const dy = (vh - dh) / 2;
    const dims = { dx, dy, dw, dh };

    const key = `${index}-${isSharp}`;
    const becameSharp = isSharp && lastDrawnKey && lastDrawnKey === `${index}-false`;
    if (becameSharp && Math.abs(frameSource.velocity) < FADE_MAX_VELOCITY && lastImg) {
      fade = { from: lastImg, dims: lastDims, startTs: performance.now() };
    }

    if (fade && performance.now() - fade.startTs < FADE_MS) {
      const t = (performance.now() - fade.startTs) / FADE_MS;
      ctx.globalAlpha = 1;
      ctx.drawImage(fade.from, fade.dims.dx, fade.dims.dy, fade.dims.dw, fade.dims.dh);
      ctx.globalAlpha = t;
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.globalAlpha = 1;
    } else {
      fade = null;
      ctx.drawImage(img, dx, dy, dw, dh);
    }

    lastDrawnKey = key;
    lastImg = img;
    lastDims = dims;
  }

  const lenis = new Lenis({ duration: 1.1, smoothWheel: true, touchMultiplier: 1.2 });
  lenis.stop(); // stays locked until the preloader calls .start()

  let lastTime = performance.now();
  function raf(time) {
    lenis.raf(time);
    const dt = (time - lastTime) / 1000;
    lastTime = time;
    const p = lenis.progress;
    lastProgress = p;
    frameSource.update(p, dt);
    draw(p);
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);

  resize();

  return lenis;
}
