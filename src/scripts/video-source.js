// Alternative sharp-tier source: a single short-GOP (keyint=15, no B-frames)
// H.264 MP4 per tier, decoded on demand via WebCodecs instead of fetching each
// frame as a separate WebP. Measured: per-frame WebP compresses out none of
// the ~95%-identical-consecutive-frame redundancy in this slow camera-flight
// footage, so it was network-byte-bound (19MB tier, ~13.5fps ceiling @4Mbps).
// The same footage as H.264 is 2-3x smaller AND hardware-decoded, moving that
// ceiling to ~30-40fps — see the video-decode task for the measured numbers.
//
// Kept as a fully isomorphic, feature-detected drop-in: frame-engine.js falls
// back to the proven per-frame WebP ring on any browser without WebCodecs
// (Safari <16.4 in particular), so there is no hard dependency on this path.
import { createFile, DataStream } from 'mp4box';

export function supportsWebCodecs() {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

// Demuxes the whole MP4 up front — our tiers are a few MB, comfortably small
// enough to hold entirely in memory rather than stream-parse incrementally.
export async function loadVideoTrack(url) {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  buf.fileStart = 0;

  return new Promise((resolve, reject) => {
    const file = createFile();
    let codec, description, codedWidth, codedHeight, trackId;

    file.onError = (e) => reject(new Error(String(e)));

    file.onReady = (info) => {
      const track = info.videoTracks[0];
      trackId = track.id;
      codec = track.codec;
      codedWidth = track.track_width;
      codedHeight = track.track_height;

      const trak = file.getTrackById(trackId);
      const entry = trak.mdia.minf.stbl.stsd.entries[0];
      const box = entry.avcC || entry.hvcC;
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      description = new Uint8Array(stream.buffer, 8); // strip the box header — WebCodecs wants just the record

      file.setExtractionOptions(trackId, null, { nbSamples: Infinity });
      file.start();
    };

    file.onSamples = (id, user, samples) => {
      resolve({
        codec,
        description,
        codedWidth,
        codedHeight,
        // Sample order === our frame index order (1-based below by the caller) —
        // encoded from the exact same resampled sequence the WebP tiers use.
        samples: samples.map((s) => ({ data: s.data, isKey: s.is_sync })),
      });
    };

    file.appendBuffer(buf);
    file.flush();
  });
}

const FPS = 24; // matches the encode; only used to give WebCodecs well-formed increasing timestamps

// Drives a persistent VideoDecoder to keep `ring` (the same Map<index,{bitmap,ts}>
// frame-engine.js already evicts from) populated around the playhead. Decode is
// inherently sequential-from-a-keyframe, unlike independent per-frame fetches,
// so this exposes one `ensure(lo, hi, idx)` call per tick rather than N
// concurrent fetch calls.
export function createVideoRing({ track, ring, ringCap }) {
  let decoder = null;
  let nextIndex = null; // next sample index (1-based) that will be fed to the decoder

  // One decoder instance for the ring's whole lifetime — reset()+configure()
  // again on reseek rather than tearing down and recreating it, since a fresh
  // configure() is required either way once state leaves 'configured'.
  function configure() {
    if (!decoder) {
      decoder = new VideoDecoder({
        // The index comes from the chunk's own timestamp, not the order
        // outputs arrive in. decoder.reset() isn't guaranteed to synchronously
        // cancel every in-flight decode, so a frame queued right before a
        // reseek can still deliver its output afterward, interleaved with the
        // new decode's outputs. A position-based FIFO would hand that late
        // arrival's pixels to whatever index was next in the (by-then
        // different) queue — a real, correctly-decoded frame silently landing
        // one or more slots away from where it belongs. Every chunk we feed
        // carries its true index as `timestamp = index/FPS` (below), and that
        // travels with the frame through decode, so reading it back here is
        // correct regardless of arrival order.
        output(frame) {
          const idx = Math.round((frame.timestamp * FPS) / 1e6);
          const prev = ring.get(idx);
          if (prev) prev.bitmap.close();
          ring.set(idx, { bitmap: frame, ts: performance.now() });
        },
        error() {}, // a dropped/corrupt decode just leaves that index missing — proxy spine covers it
      });
    } else if (decoder.state !== 'unconfigured') {
      decoder.reset();
    }
    decoder.configure({
      codec: track.codec,
      codedWidth: track.codedWidth,
      codedHeight: track.codedHeight,
      description: track.description,
    });
  }

  function nearestKeyframeAtOrBefore(index) {
    for (let i = Math.min(index, track.samples.length) - 1; i >= 0; i--) {
      if (track.samples[i].isKey) return i + 1;
    }
    return 1;
  }

  function feedFrom(startIndex, hi) {
    nextIndex = startIndex;
    for (; nextIndex <= hi; nextIndex++) {
      const s = track.samples[nextIndex - 1];
      if (!s) break;
      const chunk = new EncodedVideoChunk({
        type: s.isKey ? 'key' : 'delta',
        timestamp: Math.round((nextIndex * 1e6) / FPS),
        data: s.data,
      });
      decoder.decode(chunk);
    }
  }

  function reseek(lo, hi) {
    configure();
    feedFrom(nearestKeyframeAtOrBefore(lo), hi);
  }

  // lo/hi: desired index window (already computed by frame-engine.js's velocity
  // logic); idx: exact playhead index, used to decide reseek-vs-continue.
  function ensure(lo, hi, idx) {
    if (nextIndex === null) return reseek(lo, hi);
    // Close enough to just keep decoding forward: cheap and avoids a
    // reset+reconfigure (and the keyframe reseek's throwaway frames) on every
    // ordinary forward-scroll tick.
    const tooFarBehind = idx < nextIndex - ringCap;
    const tooFarAhead = idx > nextIndex + ringCap;
    if (tooFarBehind || tooFarAhead) return reseek(lo, hi);
    if (hi > nextIndex) feedFrom(nextIndex, hi);
  }

  // Resolves once every decode() call issued so far has delivered its output —
  // lets the caller treat the initial window the same way it treats the WebP
  // path's initial fetches (a real wait, not just "requests were sent").
  function flush() {
    return decoder && decoder.state === 'configured' ? decoder.flush() : Promise.resolve();
  }

  function destroy() {
    if (decoder && decoder.state !== 'closed') decoder.close();
    for (const entry of ring.values()) entry.bitmap.close();
    ring.clear();
  }

  return { ensure, flush, destroy };
}
