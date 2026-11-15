import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMediaRequest,
  formatBytes,
  formatDuration,
  getDedupeKey,
  parseM3u8,
  pickVideoThumbnail,
  sanitizeFilename,
  sanitizeThumbnailUrl
} from '../background/media-utils.js';

test('classifyMediaRequest detects direct MP4 and parses 206 Content-Range size', () => {
  const result = classifyMediaRequest({
    url: 'https://cdn.example.com/videos/clip.mp4?token=abc',
    contentType: 'video/mp4',
    contentLength: 65536,
    contentRange: 'bytes 0-65535/15482910'
  });

  assert.equal(result.kind, 'direct');
  assert.equal(result.ext, 'mp4');
  assert.equal(result.formatLabel, 'MP4');
  assert.equal(result.sizeBytes, 15482910);
});

test('classifyMediaRequest detects video files served as octet-stream', () => {
  const result = classifyMediaRequest({
    url: 'https://cdn.example.com/media/movie.webm',
    contentType: 'application/octet-stream',
    contentLength: 2_500_000
  });

  assert.equal(result.kind, 'direct');
  assert.equal(result.ext, 'webm');
  assert.equal(result.formatLabel, 'WEBM');
});

test('classifyMediaRequest detects HLS .m3u8 and DASH .mpd streams', () => {
  const hls = classifyMediaRequest({
    url: 'https://stream.example.com/live/master.m3u8?hdnea=123',
    contentType: 'application/vnd.apple.mpegurl'
  });
  assert.equal(hls.kind, 'hls');
  assert.equal(hls.formatLabel, 'HLS');

  const dash = classifyMediaRequest({
    url: 'https://stream.example.com/dash/manifest.mpd',
    contentType: 'application/dash+xml'
  });
  assert.equal(dash.kind, 'dash');
  assert.equal(dash.formatLabel, 'DASH');
});

test('classifyMediaRequest ignores HLS segments, tiny probes, blob URLs, and HTML', () => {
  assert.equal(
    classifyMediaRequest({
      url: 'https://stream.example.com/seg-001.ts',
      contentType: 'video/mp2t',
      contentLength: 400_000
    }),
    null
  );

  assert.equal(
    classifyMediaRequest({
      url: 'https://stream.example.com/chunk-002.m4s',
      contentType: 'video/iso.segment',
      contentLength: 200_000
    }),
    null
  );

  assert.equal(
    classifyMediaRequest({
      url: 'https://cdn.example.com/probe.mp4',
      contentType: 'video/mp4',
      contentLength: 1024
    }),
    null
  );

  assert.equal(
    classifyMediaRequest({
      url: 'blob:https://example.com/1234',
      contentType: 'video/mp4'
    }),
    null
  );
});

test('getDedupeKey strips volatile byte-range parameters while preserving auth tokens', () => {
  const a = getDedupeKey('https://cdn.example.com/video.mp4?token=xyz&bytestart=0&byteend=65535');
  const b = getDedupeKey('https://cdn.example.com/video.mp4?token=xyz&bytestart=65536&byteend=131071');
  assert.equal(a, b);
  assert.equal(a, 'https://cdn.example.com/video.mp4?token=xyz');
});

test('sanitizeFilename cleans Windows invalid chars, reserved names, and duplicate extensions', () => {
  assert.equal(
    sanitizeFilename('My: Cool / Video? *2026*.mp4', 'mp4', 'Video Downloader'),
    'Video Downloader/My Cool Video 2026.mp4'
  );
  assert.equal(sanitizeFilename('CON', 'mp4'), 'CON_video.mp4');
  assert.equal(sanitizeFilename('   ', 'webm'), 'video.webm');
});

test('parseM3u8 parses master playlist variants sorted highest resolution first', () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"
high/index.m3u8
`;
  const parsed = parseM3u8(master, 'https://cdn.example.com/video/master.m3u8');
  assert.equal(parsed.type, 'master');
  assert.equal(parsed.variants.length, 2);
  assert.equal(parsed.variants[0].qualityLabel, '1080p');
  assert.equal(parsed.variants[0].url, 'https://cdn.example.com/video/high/index.m3u8');
  assert.equal(parsed.variants[0].hasSeparateAudio, true);
  assert.equal(parsed.variants[1].qualityLabel, '360p');
});

test('parseM3u8 parses fMP4 media playlist with EXT-X-MAP and AES-128 key', () => {
  const media = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="keys/enc.key",IV=0x0000000000000000000000000000000A
#EXTINF:6.0,
seg10.m4s
#EXTINF:5.5,
seg11.m4s
#EXT-X-ENDLIST
`;
  const parsed = parseM3u8(media, 'https://cdn.example.com/video/high/index.m3u8');
  assert.equal(parsed.type, 'media');
  assert.equal(parsed.container, 'mp4');
  assert.equal(parsed.isLive, false);
  assert.equal(parsed.drmProtected, false);
  assert.equal(parsed.initSegmentUri, 'https://cdn.example.com/video/high/init.mp4');
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[0].sequence, 10);
  assert.equal(parsed.segments[0].key.uri, 'https://cdn.example.com/video/high/keys/enc.key');
  assert.equal(parsed.totalDuration, 11.5);
});

test('parseM3u8 flags SAMPLE-AES as DRM protected', () => {
  const drmMedia = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://license"
#EXTINF:4.0,
seg1.ts
#EXT-X-ENDLIST
`;
  const parsed = parseM3u8(drmMedia, 'https://cdn.example.com/drm/index.m3u8');
  assert.equal(parsed.drmProtected, true);
});

test('formatBytes and formatDuration produce clean labels', () => {
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(25 * 1024 * 1024), '25 MB');
  assert.equal(formatDuration(125), '2:05');
  assert.equal(formatDuration(3665), '1:01:05');
});

test('sanitizeThumbnailUrl accepts valid http(s) and data:image/ URLs and trims whitespace', () => {
  assert.equal(
    sanitizeThumbnailUrl('  https://cdn.example.com/thumb.jpg?w=320  '),
    'https://cdn.example.com/thumb.jpg?w=320'
  );
  assert.equal(
    sanitizeThumbnailUrl('http://cdn.example.com/poster.png'),
    'http://cdn.example.com/poster.png'
  );
  const dataJpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/';
  assert.equal(sanitizeThumbnailUrl(` ${dataJpeg} `), dataJpeg);
});

test('sanitizeThumbnailUrl rejects unsafe schemes, invalid inputs, and oversized URLs', () => {
  assert.equal(sanitizeThumbnailUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeThumbnailUrl('JAVASCRIPT:alert(1)'), null);
  assert.equal(sanitizeThumbnailUrl('blob:https://example.com/1234-5678'), null);
  assert.equal(sanitizeThumbnailUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(sanitizeThumbnailUrl('file:///C:/secret.png'), null);
  assert.equal(sanitizeThumbnailUrl('/relative/thumb.jpg'), null);
  assert.equal(sanitizeThumbnailUrl(''), null);
  assert.equal(sanitizeThumbnailUrl('   '), null);
  assert.equal(sanitizeThumbnailUrl(null), null);
  assert.equal(sanitizeThumbnailUrl(undefined), null);
  assert.equal(sanitizeThumbnailUrl(12345), null);

  const validHttpMax = `https://cdn.example.com/${'a'.repeat(2048 - 'https://cdn.example.com/'.length)}`;
  assert.equal(validHttpMax.length, 2048);
  assert.equal(sanitizeThumbnailUrl(validHttpMax), validHttpMax);
  assert.equal(sanitizeThumbnailUrl(`${validHttpMax}x`), null);

  const dataPrefix = 'data:image/jpeg;base64,';
  const validDataMax = `${dataPrefix}${'A'.repeat(40000 - dataPrefix.length)}`;
  assert.equal(validDataMax.length, 40000);
  assert.equal(sanitizeThumbnailUrl(validDataMax), validDataMax);
  assert.equal(sanitizeThumbnailUrl(`${validDataMax}A`), null);
});

test('pickVideoThumbnail follows priority order and skips unsafe/invalid candidates', () => {
  const fullMeta = {
    activeMeta: {
      poster: 'https://cdn.example.com/active-poster.jpg',
      frameThumbnail: 'data:image/jpeg;base64,ACTIVEFRAME'
    },
    pageThumbnail: 'https://cdn.example.com/og-image.jpg'
  };

  assert.equal(
    pickVideoThumbnail(
      {
        poster: 'https://cdn.example.com/item-poster.jpg',
        frameThumbnail: 'data:image/jpeg;base64,ITEMFRAME'
      },
      fullMeta
    ),
    'https://cdn.example.com/item-poster.jpg'
  );

  assert.equal(
    pickVideoThumbnail(
      {
        poster: 'javascript:alert(1)',
        frameThumbnail: 'data:image/jpeg;base64,ITEMFRAME'
      },
      fullMeta
    ),
    'data:image/jpeg;base64,ITEMFRAME'
  );

  assert.equal(
    pickVideoThumbnail(
      {
        poster: null,
        frameThumbnail: 'blob:https://example.com/frame'
      },
      fullMeta
    ),
    'https://cdn.example.com/active-poster.jpg'
  );

  assert.equal(
    pickVideoThumbnail(
      {},
      {
        activeMeta: {
          poster: '',
          frameThumbnail: 'data:image/jpeg;base64,ACTIVEFRAME'
        },
        pageThumbnail: 'https://cdn.example.com/og-image.jpg'
      }
    ),
    'data:image/jpeg;base64,ACTIVEFRAME'
  );

  assert.equal(
    pickVideoThumbnail(
      {},
      {
        activeMeta: {
          poster: null,
          frameThumbnail: null
        },
        pageThumbnail: 'https://cdn.example.com/og-image.jpg'
      }
    ),
    'https://cdn.example.com/og-image.jpg'
  );

  assert.equal(pickVideoThumbnail(null, null), null);
});
