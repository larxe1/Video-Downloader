import { parseM3u8 } from '../background/media-utils.js';

const activeJobs = new Map();
const activeBlobUrls = new Map();

/**
 * Parse an HLS IV string (0x...) or build a 16-byte big-endian IV from segment sequence.
 * @param {string|null} ivHex
 * @param {number} sequence
 * @returns {Uint8Array}
 */
function buildAesIv(ivHex, sequence) {
  const iv = new Uint8Array(16);
  if (ivHex && /^0x[0-9a-f]+$/i.test(ivHex)) {
    const clean = ivHex.slice(2).padStart(32, '0').slice(-32);
    for (let i = 0; i < 16; i++) {
      iv[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return iv;
  }
  const view = new DataView(iv.buffer);
  view.setUint32(12, sequence >>> 0, false);
  return iv;
}

/**
 * Fetch an ArrayBuffer with abort support and cookies.
 */
async function fetchBuffer(url, signal) {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while downloading segment`);
  }
  return res.arrayBuffer();
}

/**
 * Fetch and parse an M3U8 playlist, automatically resolving master playlists to the best variant.
 */
async function resolveMediaPlaylist(url, signal) {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) {
    throw new Error(`Could not load stream playlist (HTTP ${res.status})`);
  }
  const text = await res.text();
  const parsed = parseM3u8(text, res.url || url);

  if (parsed.type === 'master') {
    if (!parsed.variants.length) {
      throw new Error('No playable video streams found in playlist.');
    }
    const best = parsed.variants[0];
    const subRes = await fetch(best.url, { credentials: 'include', signal });
    if (!subRes.ok) {
      throw new Error(`Could not load quality stream (HTTP ${subRes.status})`);
    }
    const subText = await subRes.text();
    const subParsed = parseM3u8(subText, subRes.url || best.url);
    if (subParsed.type !== 'media') {
      throw new Error('Nested playlist did not contain video segments.');
    }
    return subParsed;
  }

  return parsed;
}

async function runHlsDownload({ jobId, url, baseFilename }) {
  const controller = new AbortController();
  activeJobs.set(jobId, controller);

  const sendProgress = (patch) => {
    chrome.runtime.sendMessage({
      type: 'HLS_PROGRESS',
      jobId,
      ...patch
    }).catch(() => {});
  };

  try {
    sendProgress({ status: 'preparing', progress: 0 });
    const playlist = await resolveMediaPlaylist(url, controller.signal);

    if (playlist.drmProtected) {
      throw new Error('This video uses DRM encryption and cannot be downloaded.');
    }

    if (!playlist.segments.length) {
      throw new Error('No video segments were found in this stream.');
    }

    const totalSegments = playlist.segments.length;
    const chunks = new Array(totalSegments);
    const keyCache = new Map();
    let initBuffer = null;

    if (playlist.initSegmentUri) {
      initBuffer = await fetchBuffer(playlist.initSegmentUri, controller.signal);
    }

    let completedSegments = 0;
    let bytesDownloaded = initBuffer ? initBuffer.byteLength : 0;
    let lastReportTime = 0;

    sendProgress({
      status: 'downloading',
      totalSegments,
      completedSegments: 0,
      bytesDownloaded,
      progress: 0,
      isLive: playlist.isLive
    });

    const getAesCryptoKey = async (keyUri) => {
      if (keyCache.has(keyUri)) return keyCache.get(keyUri);
      const promise = (async () => {
        const rawKey = await fetchBuffer(keyUri, controller.signal);
        return crypto.subtle.importKey(
          'raw',
          rawKey,
          { name: 'AES-CBC' },
          false,
          ['decrypt']
        );
      })();
      keyCache.set(keyUri, promise);
      return promise;
    };

    let nextIndex = 0;
    const CONCURRENCY = Math.min(4, totalSegments);

    const worker = async () => {
      while (!controller.signal.aborted) {
        const idx = nextIndex++;
        if (idx >= totalSegments) return;

        const seg = playlist.segments[idx];
        let data = await fetchBuffer(seg.uri, controller.signal);

        if (seg.key && seg.key.method === 'AES-128') {
          const cryptoKey = await getAesCryptoKey(seg.key.uri);
          const iv = buildAesIv(seg.key.iv, seg.sequence);
          data = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
        }

        chunks[idx] = data;
        completedSegments++;
        bytesDownloaded += data.byteLength;

        const now = Date.now();
        if (now - lastReportTime >= 220 || completedSegments === totalSegments) {
          lastReportTime = now;
          sendProgress({
            status: 'downloading',
            totalSegments,
            completedSegments,
            bytesDownloaded,
            progress: Math.round((completedSegments / totalSegments) * 100)
          });
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    if (controller.signal.aborted) {
      throw new DOMException('Cancelled', 'AbortError');
    }

    sendProgress({
      status: 'assembling',
      totalSegments,
      completedSegments,
      bytesDownloaded,
      progress: 100
    });

    const parts = initBuffer ? [initBuffer, ...chunks] : chunks;
    const mimeType = playlist.container === 'mp4' ? 'video/mp4' : 'video/mp2t';
    const blob = new Blob(parts, { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    activeBlobUrls.set(jobId, blobUrl);

    // Ensure final filename extension matches actual stream container (.mp4 or .ts)
    const stripped = baseFilename.replace(/\.(mp4|ts)$/i, '');
    const finalFilename = `${stripped}.${playlist.container}`;

    chrome.runtime.sendMessage({
      type: 'HLS_READY',
      jobId,
      blobUrl,
      filename: finalFilename,
      byteLength: blob.size
    }).catch(() => {});
  } catch (err) {
    if (err?.name === 'AbortError') {
      chrome.runtime.sendMessage({
        type: 'HLS_CANCELLED',
        jobId
      }).catch(() => {});
    } else {
      chrome.runtime.sendMessage({
        type: 'HLS_ERROR',
        jobId,
        error: err?.message || 'Failed to download video stream.'
      }).catch(() => {});
    }
  } finally {
    activeJobs.delete(jobId);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'OFFSCREEN_DOWNLOAD_HLS') {
    runHlsDownload(message);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'OFFSCREEN_CANCEL_HLS') {
    const controller = activeJobs.get(message.jobId);
    if (controller) {
      controller.abort();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'OFFSCREEN_REVOKE_BLOB') {
    if (message.blobUrl) {
      URL.revokeObjectURL(message.blobUrl);
    }
    if (message.jobId) {
      activeBlobUrls.delete(message.jobId);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
