import { supportsWebCodecs, loadVideoTrack, createVideoRing } from './video-source.js';

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
// Layer 2 — the sharp ring: a Map<index, ImageBitmap>, fetched around the
// current scroll position and evicted once out of range. Desktop gets full
// 1920x1080; mobile gets 1600x900 rather than matching desktop exactly —
// measured under throttled conditions (4x CPU, 4Mbps/40ms network), 1080p on
// mobile only sustained ~4 fetched-frames/sec, well short of what real-time
// scrolling needs, while 1600x900 sustains ~5-6 fps. `id` still distinguishes
// desktop/mobile for tuning ring size / concurrency / DPR beyond resolution.
// Thinned from the source's 527 frames to 264 (every other frame): halves
// required fetch+decode throughput, which measurement showed was the actual
// bottleneck on constrained connections (not paint/scheduling). The
// proxy->sharp crossfade already covers the larger per-step visual jump.
const SHARP_COUNT = 264;
const PROXY_COUNT = 176;

const RING_CAP = { desktop: 48, mobile: 36 };
// Mobile's concurrency was 5, which under a bandwidth-constrained connection
// meant 5 large fetches contending for the same thin pipe — measured
// throughput roughly *doubled* by dropping to 2 concurrent fetches instead,
// since each one then gets a bigger share of the available bandwidth.
const CONCURRENCY = { desktop: 8, mobile: 2 };
const FETCH_BEHIND = 6;
// Minimum forward prefetch, in frames — this was 10, which is only ~150ms of
// buffer at a brisk-but-deliberate scroll speed. Too thin: the ring couldn't
// stay ahead during ordinary slow scrolling (not just fast flicks), so
// frames kept arriving just as the playhead reached them, forcing a
// proxy-fallback + crossfade on nearly every new frame — which reads as
// choppiness, not the occasional graceful degradation it was meant to be.
const MIN_AHEAD = 24;
const MIN_AGE_MS = 400;
const EVICT_THROTTLE_MS = 200;
const HYSTERESIS_GAP = 10;
// Short and gated to near-total-stop: a visible dissolve firing repeatedly
// while the user is still (slowly) scrolling reads as an inconsistent,
// unsettled motion — worse than a rare, brief pop. Wider prefetch above
// means this should now rarely even trigger outside first-visit-to-a-region.
const FADE_MS = 70;
const FADE_MAX_VELOCITY = 0.75; // frames/sec — near-total-stop only

export function tierFor(width) {
  return width >= 1024
    ? { id: 'desktop', dir: '1080p', width: 1920, height: 1080, video: '/frames/1080p.mp4' }
    : { id: 'mobile', dir: '1600p', width: 1600, height: 900, video: '/frames/1600p.mp4' };
}

const pad3 = (i) => String(i).padStart(3, '0');
const sharpPath = (dir, i) => `/frames/${dir}/frame_${pad3(i)}.webp`;
const proxyPath = (i) => `/frames/proxy/frame_${pad3(i)}.webp`;

async function fetchBitmap(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('bad status');
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  return { bitmap, bytes: blob.size };
}

// Average sharp-frame size measured from the actual built tiers (13MB/264
// frames desktop, 9.5MB/264 mobile) x a 20fps sustain target — the minimum
// arrival rate that doesn't read as choppy. `saveData` (checked by the
// caller) only catches users who opted into Data Saver; it misses Safari/iOS
// (no Network Information API at all) and ordinary-but-slow connections. This
// measures the proxy spine's actual download speed as a connection-API-free
// fallback signal for those cases.
const SHARP_KBPS_FOR_SMOOTH = { desktop: 50 * 20, mobile: 37 * 20 };

export function createFrameEngine({ tier, proxyOnly = false }) {
  const proxyImgs = new Array(PROXY_COUNT);
  let forcedProxyOnly = proxyOnly;

  let ring = new Map(); // index -> { bitmap, ts } — bitmap is an ImageBitmap (WebP path) or VideoFrame (video path); both share close()
  let inFlight = new Map(); // index -> AbortController
  let lastEvict = 0;
  const readyCbs = [];
  let videoRing = null; // non-null once the WebCodecs video path is active for the current tier

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
    let totalBytes = 0;
    const t0 = performance.now();
    const jobs = [];
    for (let i = 1; i <= PROXY_COUNT; i++) {
      jobs.push(
        fetchBitmap(proxyPath(i))
          .then(({ bitmap, bytes }) => {
            proxyImgs[i - 1] = bitmap;
            totalBytes += bytes;
          })
          .catch(() => {})
          .finally(() => {
            done++;
            onProgress?.(done, PROXY_COUNT);
          })
      );
    }
    return Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, BAIL_MS))]).then(() => {
      if (forcedProxyOnly) return; // already decided (reduced-motion / saveData) — nothing to measure for
      const elapsed = (performance.now() - t0) / 1000;
      if (elapsed < 0.05 || totalBytes === 0) return; // too fast/small to trust the measurement
      const kbps = totalBytes / 1024 / elapsed;
      if (kbps < SHARP_KBPS_FOR_SMOOTH[tier.id]) forcedProxyOnly = true;
    });
  }

  // The video path replaces per-frame WebP fetches with a single small H.264
  // file, hardware-decoded — see video-source.js for why. Feature-detected
  // with a silent catch: any failure (unsupported codec config, network
  // error) just leaves videoRing null, and every call site below already
  // falls back to the proven per-frame WebP path whenever it's null.
  function startVideoSource() {
    if (forcedProxyOnly || !supportsWebCodecs() || !tier.video) return Promise.resolve();
    return loadVideoTrack(tier.video)
      .then((track) => {
        videoRing = createVideoRing({ track, ring, ringCap: RING_CAP[tier.id] });
      })
      .catch(() => {
        videoRing = null;
      });
  }

  async function fetchSharp(index) {
    if (forcedProxyOnly || ring.has(index) || inFlight.has(index)) return;
    const controller = new AbortController();
    inFlight.set(index, controller);
    const t0 = performance.now();
    try {
      const { bitmap } = await fetchBitmap(sharpPath(tier.dir, index), controller.signal);
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
    if (forcedProxyOnly) return Promise.resolve();
    const idx = sharpIndexFor(0);
    const lo = Math.max(1, idx - FETCH_BEHIND);
    const hi = Math.min(SHARP_COUNT, idx + MIN_AHEAD);

    return startVideoSource().then(() => {
      if (videoRing) {
        onProgress?.(0, 1);
        videoRing.ensure(lo, hi, idx);
        // flush() can legitimately reject (AbortError) if the playhead moves
        // enough before it resolves to trigger a reseek — priming is
        // best-effort polish either way, so treat that the same as timing out.
        return Promise.race([videoRing.flush(), new Promise((r) => setTimeout(r, 6000))])
          .catch(() => {})
          .then(() => {
            onProgress?.(1, 1);
          });
      }
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
    });
  }

  function update(p, dt) {
    const idx = sharpIndexFor(p);
    if (dt > 0) {
      const instV = (idx - prevIndex) / dt;
      vFrames = vFrames * 0.75 + instV * 0.25;
    }
    prevIndex = idx;
    if (forcedProxyOnly) return;

    const absV = Math.abs(vFrames);
    let stride = 1;
    if (capacity > 4 && absV > capacity) {
      stride = Math.max(1, Math.min(8, 2 ** Math.ceil(Math.log2(absV / Math.max(capacity, 8)))));
    }

    const ringCap = RING_CAP[tier.id];
    const ahead = Math.max(MIN_AHEAD, Math.min(ringCap - FETCH_BEHIND - 2, Math.round(absV * 0.35)));
    const dir = vFrames >= 0 ? 1 : -1;
    const lo = Math.max(1, idx - (dir > 0 ? FETCH_BEHIND : ahead));
    const hi = Math.min(SHARP_COUNT, idx + (dir > 0 ? ahead : FETCH_BEHIND));
    const keepLo = lo - HYSTERESIS_GAP;
    const keepHi = hi + HYSTERESIS_GAP;

    if (videoRing) {
      videoRing.ensure(lo, hi, idx);
      evict(keepLo, keepHi);
      return;
    }

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
    if (!forcedProxyOnly) {
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
    if (forcedProxyOnly || switching || next.id === tier.id) return;
    switching = true;
    if (videoRing) videoRing.destroy(); // closes its own ring entries + decoder
    videoRing = null;
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
    // Gated behind ?debug=1 in main.js — lets a real-device issue be diagnosed
    // by having the user read numbers off an on-screen overlay, since there's
    // no way to attach devtools to their phone remotely.
    get debugInfo() {
      return {
        path: forcedProxyOnly ? 'proxy-only' : videoRing ? 'video' : 'webp',
        ringSize: ring.size,
        inFlight: inFlight.size,
        capacity: Math.round(capacity),
        velocity: Math.round(vFrames),
      };
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

  // VideoFrame (the WebCodecs path) exposes displayWidth/displayHeight rather
  // than width/height like ImageBitmap — this keeps both drawable uniformly.
  const srcW = img.displayWidth ?? img.width;
  const srcH = img.displayHeight ?? img.height;
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
  // Both tiers now serve the same 1920x1080 source, so the cap difference is
  // about real GPU fill-rate headroom (desktop GPUs vs. phone GPUs), not
  // source resolution anymore.
  return tierId === 'desktop' ? 1.5 : 1.3;
}
