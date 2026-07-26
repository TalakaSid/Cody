// Isomorphic frame source + painter — no `window`/`document`/`Image` access,
// so this same module runs unchanged inside a Worker (paint via OffscreenCanvas)
// or on the main thread (fallback for browsers without
// transferControlToOffscreen). Tier/viewport info is always passed in by the
// caller, which is the only side that has DOM access.
//
// Layer 1 — the proxy spine: all PROXY_COUNT frames, small (854x480), loaded in
// full up front and never evicted. Guarantees there is always something correct
// to draw at every scroll position, so the ring buffer below can be aggressive
// about eviction without ever risking a blank canvas.
//
// Layer 2 — the sharp ring: a Map<index, ImageBitmap> for the tier-appropriate
// resolution (720p mobile / 1080p desktop), fetched around the current scroll
// position and evicted once out of range.
const SHARP_COUNT = 527;
const PROXY_COUNT = 176;

const RING_CAP = { desktop: 26, mobile: 32 };
const CONCURRENCY = { desktop: 6, mobile: 4 };
const FETCH_BEHIND = 6;
const MIN_AGE_MS = 400;
const EVICT_THROTTLE_MS = 200;
const HYSTERESIS_GAP = 10;
const FADE_MS = 120;
const FADE_MAX_VELOCITY = 2; // frames/sec — only crossfade proxy->sharp near-stationary

export function tierFor(width) {
  return width >= 1024
    ? { id: 'desktop', dir: '1080p', width: 1920, height: 1080 }
    : { id: 'mobile', dir: '720p', width: 1280, height: 720 };
}

const pad3 = (i) => String(i).padStart(3, '0');
const sharpPath = (dir, i) => `/frames/${dir}/frame_${pad3(i)}.webp`;
const proxyPath = (i) => `/frames/proxy/frame_${pad3(i)}.webp`;

async function fetchBitmap(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('bad status');
  const blob = await res.blob();
  return createImageBitmap(blob);
}

export function createFrameEngine({ tier, proxyOnly = false }) {
  const proxyImgs = new Array(PROXY_COUNT);

  let ring = new Map(); // index -> { bitmap, ts }
  let inFlight = new Map(); // index -> AbortController
  let lastEvict = 0;
  const readyCbs = [];

  let prevIndex = 1;
  let vFrames = 0; // EMA-smoothed signed frames/sec
  let capacity = 40; // EMA of measured fetch throughput (frames/sec)

  const proxyIndexFor = (p) => Math.round(p * (PROXY_COUNT - 1)) + 1;
  const sharpIndexFor = (p) => Math.round(p * (SHARP_COUNT - 1)) + 1;

  function notifyReady() {
    readyCbs.forEach((cb) => cb());
  }

  function loadSpine(onProgress) {
    const BAIL_MS = 8000;
    let done = 0;
    const jobs = [];
    for (let i = 1; i <= PROXY_COUNT; i++) {
      jobs.push(
        fetchBitmap(proxyPath(i))
          .then((bitmap) => {
            proxyImgs[i - 1] = bitmap;
          })
          .catch(() => {})
          .finally(() => {
            done++;
            onProgress?.(done, PROXY_COUNT);
          })
      );
    }
    return Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, BAIL_MS))]);
  }

  async function fetchSharp(index) {
    if (proxyOnly || ring.has(index) || inFlight.has(index)) return;
    const controller = new AbortController();
    inFlight.set(index, controller);
    const t0 = performance.now();
    try {
      const bitmap = await fetchBitmap(sharpPath(tier.dir, index), controller.signal);
      const dt = (performance.now() - t0) / 1000;
      if (dt > 0.001) capacity = capacity * 0.7 + (1 / dt) * 0.3;
      ring.set(index, { bitmap, ts: performance.now() });
      notifyReady();
    } catch {
      // aborted or failed — the proxy spine covers this index regardless
    } finally {
      inFlight.delete(index);
    }
  }

  function evict(keepLo, keepHi) {
    const cap = RING_CAP[tier.id];
    const now = performance.now();
    if (ring.size <= cap && now - lastEvict < EVICT_THROTTLE_MS) return;
    lastEvict = now;
    const candidates = [];
    for (const [i, entry] of ring) {
      if (i >= keepLo && i <= keepHi) continue;
      if (now - entry.ts < MIN_AGE_MS) continue;
      candidates.push(i);
    }
    candidates.sort((a, b) => Math.abs(b - prevIndex) - Math.abs(a - prevIndex));
    let overBy = ring.size - cap;
    for (const i of candidates) {
      if (overBy <= 0) break;
      ring.get(i).bitmap.close();
      ring.delete(i);
      overBy--;
    }
  }

  function primeWindow(onProgress) {
    if (proxyOnly) return Promise.resolve();
    const idx = sharpIndexFor(0);
    const lo = Math.max(1, idx - FETCH_BEHIND);
    const hi = Math.min(SHARP_COUNT, idx + 24);
    const total = hi - lo + 1;
    let done = 0;
    const jobs = [];
    for (let i = lo; i <= hi; i++) {
      jobs.push(
        fetchSharp(i).then(() => {
          done++;
          onProgress?.(done, total);
        })
      );
    }
    return Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 6000))]);
  }

  function update(p, dt) {
    const idx = sharpIndexFor(p);
    if (dt > 0) {
      const instV = (idx - prevIndex) / dt;
      vFrames = vFrames * 0.75 + instV * 0.25;
    }
    prevIndex = idx;
    if (proxyOnly) return;

    const absV = Math.abs(vFrames);
    let stride = 1;
    if (capacity > 4 && absV > capacity) {
      stride = Math.max(1, Math.min(8, 2 ** Math.ceil(Math.log2(absV / Math.max(capacity, 8)))));
    }

    const ringCap = RING_CAP[tier.id];
    const ahead = Math.max(10, Math.min(ringCap - FETCH_BEHIND - 2, Math.round(absV * 0.35)));
    const dir = vFrames >= 0 ? 1 : -1;
    const lo = Math.max(1, idx - (dir > 0 ? FETCH_BEHIND : ahead));
    const hi = Math.min(SHARP_COUNT, idx + (dir > 0 ? ahead : FETCH_BEHIND));
    const keepLo = lo - HYSTERESIS_GAP;
    const keepHi = hi + HYSTERESIS_GAP;

    for (const [i, controller] of inFlight) {
      if (i < keepLo || i > keepHi) {
        controller.abort();
        inFlight.delete(i);
      }
    }

    const targets = [];
    for (let i = lo; i <= hi; i += stride) targets.push(i);
    if (!targets.includes(idx)) targets.push(idx);
    targets.sort((a, b) => Math.abs(a - idx) - Math.abs(b - idx));

    const cap = CONCURRENCY[tier.id];
    for (const i of targets) {
      if (inFlight.size >= cap) break;
      if (!ring.has(i)) fetchSharp(i);
    }

    evict(keepLo, keepHi);
  }

  function get(p) {
    const idx = sharpIndexFor(p);
    if (!proxyOnly) {
      if (ring.has(idx)) return { img: ring.get(idx).bitmap, isSharp: true, index: idx };
      for (let d = 1; d <= 8; d++) {
        const behind = idx - d;
        const ahead = idx + d;
        if (behind >= 1 && ring.has(behind)) return { img: ring.get(behind).bitmap, isSharp: true, index: behind };
        if (ahead <= SHARP_COUNT && ring.has(ahead)) return { img: ring.get(ahead).bitmap, isSharp: true, index: ahead };
      }
    }
    const pIdx = proxyIndexFor(p);
    return { img: proxyImgs[pIdx - 1], isSharp: false, index: idx };
  }

  function onReady(cb) {
    readyCbs.push(cb);
  }

  let switching = false;
  function setTier(next) {
    if (proxyOnly || switching || next.id === tier.id) return;
    switching = true;
    const oldRing = ring;
    ring = new Map();
    for (const controller of inFlight.values()) controller.abort();
    inFlight = new Map();
    tier = next;
    primeWindow().finally(() => {
      for (const entry of oldRing.values()) entry.bitmap.close();
      switching = false;
    });
  }

  return {
    get tier() {
      return tier;
    },
    get velocity() {
      return vFrames;
    },
    loadSpine,
    primeWindow,
    update,
    get,
    onReady,
    setTier,
  };
}

// Cover-fit draw with a proxy->sharp crossfade, shared by the worker and the
// main-thread fallback. `fadeState` is a mutable { from, dims, startTs } box
// the caller keeps between calls (module-level state would leak across
// multiple engines/canvases, e.g. during tests).
export function drawFrame(ctx, vw, vh, frame, velocity, fadeState) {
  const { img, isSharp, index } = frame;
  if (!img) return;

  const srcW = img.width;
  const srcH = img.height;
  const scale = Math.max(vw / srcW, vh / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const dx = (vw - dw) / 2;
  const dy = (vh - dh) / 2;
  const dims = { dx, dy, dw, dh };

  const key = `${index}-${isSharp}`;
  const becameSharp = isSharp && fadeState.lastKey === `${index}-false`;
  if (becameSharp && Math.abs(velocity) < FADE_MAX_VELOCITY && fadeState.lastImg) {
    fadeState.from = fadeState.lastImg;
    fadeState.fromDims = fadeState.lastDims;
    fadeState.startTs = performance.now();
  }

  if (fadeState.from && performance.now() - fadeState.startTs < FADE_MS) {
    const t = (performance.now() - fadeState.startTs) / FADE_MS;
    ctx.globalAlpha = 1;
    ctx.drawImage(fadeState.from, fadeState.fromDims.dx, fadeState.fromDims.dy, fadeState.fromDims.dw, fadeState.fromDims.dh);
    ctx.globalAlpha = t;
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.globalAlpha = 1;
  } else {
    fadeState.from = null;
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  fadeState.lastKey = key;
  fadeState.lastImg = img;
  fadeState.lastDims = dims;
}

export function applyCanvasSize(canvas, ctx, cssW, cssH, dpr, pxW, pxH) {
  canvas.width = pxW ?? Math.round(cssW * dpr);
  canvas.height = pxH ?? Math.round(cssH * dpr);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

export function dprCapFor(tierId) {
  return tierId === 'desktop' ? 1.3 : 1.15;
}
