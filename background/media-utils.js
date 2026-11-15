/**
 * Pure media classification, URL normalization, filename sanitization,
 * and M3U8 playlist parsing helpers shared across extension contexts.
 */

const SEGMENT_EXTENSIONS = new Set([
  'ts', 'm4s', 'cmfv', 'cmfa', 'vtt', 'srt', 'ass', 'key'
]);

const VIDEO_EXTENSIONS = new Map([
  ['mp4', 'MP4'],
  ['m4v', 'MP4'],
  ['webm', 'WEBM'],
  ['mov', 'MOV'],
  ['mkv', 'MKV'],
  ['ogv', 'OGV'],
  ['flv', 'FLV'],
  ['avi', 'AVI'],
  ['3gp', '3GP']
]);

const HLS_MIME_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl'
]);

const DASH_MIME_TYPES = new Set([
  'application/dash+xml'
]);

const DIRECT_VIDEO_MIME_EXT = new Map([
  ['video/mp4', 'mp4'],
  ['video/x-m4v', 'mp4'],
  ['video/webm', 'webm'],
  ['video/quicktime', 'mov'],
  ['video/x-matroska', 'mkv'],
  ['video/ogg', 'ogv'],
  ['video/x-flv', 'flv'],
  ['video/x-msvideo', 'avi'],
  ['video/3gpp', '3gp']
]);

const GENERIC_BINARY_MIMES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream'
]);

const MIN_DIRECT_VIDEO_BYTES = 30 * 1024; // Ignore tiny <30KB tracking/probe responses
const VOLATILE_RANGE_PARAMS = new Set(['bytestart', 'byteend', 'range']);

/**
 * Safely extract a lowercase file extension from a URL pathname.
 * @param {URL} parsedUrl
 * @returns {string}
 */
export function getUrlExtension(parsedUrl) {
  const segment = parsedUrl.pathname.split('/').pop() || '';
  const dotIdx = segment.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === segment.length - 1) return '';
  return segment.slice(dotIdx + 1).toLowerCase();
}

/**
 * Parse Content-Range header (e.g. "bytes 0-65535/15482910") to get total byte size.
 * @param {string|null|undefined} contentRange
 * @returns {number|null}
 */
export function parseContentRangeTotal(contentRange) {
  if (!contentRange || typeof contentRange !== 'string') return null;
  const match = contentRange.match(/bytes\s+(?:\d+-\d+|\*)\/(\d+)/i);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * Build a stable deduplication key for a media URL while ignoring volatile byte-range parameters.
 * @param {string} rawUrl
 * @returns {string}
 */
export function getDedupeKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    for (const key of Array.from(u.searchParams.keys())) {
      if (VOLATILE_RANGE_PARAMS.has(key.toLowerCase())) {
        u.searchParams.delete(key);
      }
    }
    u.hash = '';
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Classify an HTTP response as a downloadable video, HLS stream, or DASH manifest.
 * Returns null if the request should be ignored (segments, non-media, tiny probes).
 *
 * @param {{
 *   url: string,
 *   contentType?: string|null,
 *   contentLength?: number|null,
 *   contentRange?: string|null
 * }} info
 * @returns {{
 *   kind: 'direct' | 'hls' | 'dash',
 *   ext: string,
 *   formatLabel: string,
 *   mimeType: string,
 *   sizeBytes: number|null,
 *   dedupeKey: string
 * } | null}
 */
export function classifyMediaRequest({
  url,
  contentType = '',
  contentLength = null,
  contentRange = null
}) {
  if (!url || typeof url !== 'string') return null;

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return null;
  }

  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = getUrlExtension(parsedUrl);

  // Skip streaming chunk files & captions so the list stays focused on full videos/playlists
  if (SEGMENT_EXTENSIONS.has(ext) || mime === 'video/mp2t') {
    return null;
  }

  if (
    mime.startsWith('image/') ||
    mime.startsWith('text/html') ||
    mime === 'application/javascript' ||
    mime === 'text/javascript' ||
    mime === 'application/json' ||
    mime === 'text/css'
  ) {
    return null;
  }

  const totalRangeBytes = parseContentRangeTotal(contentRange);
  const parsedLength =
    typeof contentLength === 'number' && Number.isFinite(contentLength) && contentLength > 0
      ? contentLength
      : null;
  const sizeBytes = totalRangeBytes ?? parsedLength;

  if (ext === 'm3u8' || HLS_MIME_TYPES.has(mime)) {
    return {
      kind: 'hls',
      ext: 'mp4',
      formatLabel: 'HLS',
      mimeType: mime || 'application/vnd.apple.mpegurl',
      sizeBytes: null,
      dedupeKey: getDedupeKey(url)
    };
  }

  if (ext === 'mpd' || DASH_MIME_TYPES.has(mime)) {
    return {
      kind: 'dash',
      ext: 'mpd',
      formatLabel: 'DASH',
      mimeType: mime || 'application/dash+xml',
      sizeBytes: null,
      dedupeKey: getDedupeKey(url)
    };
  }

  // Skip tiny non-stream probes when the total size is known to be tiny
  if (sizeBytes !== null && sizeBytes < MIN_DIRECT_VIDEO_BYTES && totalRangeBytes === null && !contentRange) {
    return null;
  }
  if (totalRangeBytes !== null && totalRangeBytes < MIN_DIRECT_VIDEO_BYTES) {
    return null;
  }

  if (DIRECT_VIDEO_MIME_EXT.has(mime)) {
    const resolvedExt = DIRECT_VIDEO_MIME_EXT.get(mime);
    return {
      kind: 'direct',
      ext: resolvedExt,
      formatLabel: resolvedExt.toUpperCase(),
      mimeType: mime,
      sizeBytes,
      dedupeKey: getDedupeKey(url)
    };
  }

  if (mime.startsWith('video/')) {
    const fallbackExt = VIDEO_EXTENSIONS.has(ext) ? ext : 'mp4';
    return {
      kind: 'direct',
      ext: fallbackExt,
      formatLabel: fallbackExt.toUpperCase(),
      mimeType: mime,
      sizeBytes,
      dedupeKey: getDedupeKey(url)
    };
  }

  if (VIDEO_EXTENSIONS.has(ext) && GENERIC_BINARY_MIMES.has(mime)) {
    return {
      kind: 'direct',
      ext,
      formatLabel: VIDEO_EXTENSIONS.get(ext),
      mimeType: mime || `video/${ext}`,
      sizeBytes,
      dedupeKey: getDedupeKey(url)
    };
  }

  return null;
}

/**
 * Derive a safe Windows-compatible filename from a page title or URL.
 * @param {string} rawTitle
 * @param {string} ext
 * @param {string} [subfolder]
 * @returns {string}
 */
export function sanitizeFilename(rawTitle, ext = 'mp4', subfolder = '') {
  const cleanExt = String(ext || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
  let base = String(rawTitle || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip trailing extension if it already matches
  const extSuffix = `.${cleanExt}`;
  if (base.toLowerCase().endsWith(extSuffix)) {
    base = base.slice(0, -extSuffix.length).trim();
  }

  base = base.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!base) base = 'video';
  if (base.length > 100) base = base.slice(0, 100).trim();

  // Avoid Windows reserved device names
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) {
    base = `${base}_video`;
  }

  const file = `${base}.${cleanExt}`;
  const cleanFolder = String(subfolder || '')
    .replace(/[\u0000-\u001f<>:"\\|?*]+/g, '')
    .replace(/^\/+|\/+$/g, '')
    .trim();

  return cleanFolder ? `${cleanFolder}/${file}` : file;
}

/**
 * Derive a fallback name from a URL path when page title is unavailable.
 * @param {string} rawUrl
 * @returns {string}
 */
export function getNameFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const part = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    const withoutExt = part.replace(/\.[a-z0-9]{2,5}$/i, '');
    return decodeURIComponent(withoutExt).replace(/[_-]+/g, ' ').trim() || u.hostname;
  } catch {
    return 'video';
  }
}

/**
 * Format bytes into a concise human-readable string.
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

/**
 * Format seconds into MM:SS or H:MM:SS.
 * @param {number|null|undefined} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Parse an attribute list from an HLS tag such as EXT-X-STREAM-INF or EXT-X-KEY.
 * @param {string} attrString
 * @returns {Record<string, string>}
 */
export function parseHlsAttributes(attrString) {
  const attrs = {};
  const regex = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    attrs[match[1]] = match[3] !== undefined ? match[3] : match[2].trim();
  }
  return attrs;
}

/**
 * Parse an HLS .m3u8 master or media playlist.
 * @param {string} text
 * @param {string} baseUrl
 */
export function parseM3u8(text, baseUrl) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'));

  if (isMaster) {
    const variants = [];
    const audioTracks = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-MEDIA:')) {
        const attrs = parseHlsAttributes(line.slice('#EXT-X-MEDIA:'.length));
        if (attrs.TYPE === 'AUDIO' && attrs.URI) {
          audioTracks.push({
            groupId: attrs['GROUP-ID'] || '',
            name: attrs.NAME || 'Audio',
            language: attrs.LANGUAGE || '',
            uri: new URL(attrs.URI, baseUrl).href
          });
        }
        continue;
      }

      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = parseHlsAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
        // Next non-comment line is the variant playlist URI
        let nextUri = '';
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].startsWith('#')) {
            nextUri = lines[j];
            i = j;
            break;
          }
        }
        if (!nextUri) continue;

        const resolution = attrs.RESOLUTION || '';
        const resParts = resolution.split('x').map(Number);
        const width = resParts.length === 2 && Number.isFinite(resParts[0]) ? resParts[0] : 0;
        const height = resParts.length === 2 && Number.isFinite(resParts[1]) ? resParts[1] : 0;
        const bandwidth = Number(attrs.BANDWIDTH) || Number(attrs['AVERAGE-BANDWIDTH']) || 0;

        variants.push({
          url: new URL(nextUri, baseUrl).href,
          bandwidth,
          resolution,
          width,
          height,
          qualityLabel: height ? `${height}p` : (bandwidth ? `${Math.round(bandwidth / 1000)} kbps` : 'Stream'),
          codecs: attrs.CODECS || '',
          audioGroupId: attrs.AUDIO || ''
        });
      }
    }

    variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));

    // Flag whether variants depend on a separate audio URI (unmuxed audio)
    const audioGroupWithUri = new Set(audioTracks.map((t) => t.groupId));
    for (const variant of variants) {
      variant.hasSeparateAudio = Boolean(variant.audioGroupId && audioGroupWithUri.has(variant.audioGroupId));
    }

    return {
      type: 'master',
      variants,
      audioTracks
    };
  }

  // Media playlist
  const segments = [];
  let initSegmentUri = null;
  let currentKey = null;
  let drmProtected = false;
  let pendingDuration = 0;
  let totalDuration = 0;
  let mediaSequence = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseHlsAttributes(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        initSegmentUri = new URL(attrs.URI, baseUrl).href;
      }
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseHlsAttributes(line.slice('#EXT-X-KEY:'.length));
      const method = (attrs.METHOD || 'NONE').toUpperCase();
      if (method === 'NONE') {
        currentKey = null;
      } else if (method === 'AES-128' && attrs.URI) {
        currentKey = {
          method,
          uri: new URL(attrs.URI, baseUrl).href,
          iv: attrs.IV || null
        };
      } else {
        drmProtected = true;
      }
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const durStr = line.slice('#EXTINF:'.length).split(',')[0];
      const dur = Number(durStr);
      pendingDuration = Number.isFinite(dur) ? dur : 0;
      continue;
    }

    if (!line.startsWith('#')) {
      const seq = mediaSequence + segments.length;
      segments.push({
        uri: new URL(line, baseUrl).href,
        duration: pendingDuration,
        sequence: seq,
        key: currentKey
      });
      totalDuration += pendingDuration;
      pendingDuration = 0;
    }
  }

  const isLive = !lines.some((l) => l === '#EXT-X-ENDLIST');
  const container = initSegmentUri ? 'mp4' : 'ts';

  return {
    type: 'media',
    segments,
    initSegmentUri,
    container,
    isLive,
    drmProtected,
    totalDuration
  };
}
