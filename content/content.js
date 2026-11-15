(() => {
  const RUNTIME_ID = chrome.runtime?.id || 'local';
  if (window.__freeVideoDownloaderRuntimeId === RUNTIME_ID) return;

  if (typeof window.__freeVideoDownloaderCleanup === 'function') {
    try {
      window.__freeVideoDownloaderCleanup();
    } catch {
      // Previous context may already be invalidated after extension reload
    }
  }
  window.__freeVideoDownloaderRuntimeId = RUNTIME_ID;

  const listenerController = new AbortController();
  const MAX_FRAME_DATA_URL_LENGTH = 40000;
  const MAX_FRAME_WIDTH = 160;

  function getSafePageTitle() {
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
    const raw = (ogTitle && ogTitle.trim()) || document.title || '';
    if (raw) return raw;
    try {
      if (window.top && window.top !== window && window.top.document?.title) {
        return window.top.document.title;
      }
    } catch {
      // Cross-origin top frame: ignore safely
    }
    return location.hostname;
  }

  function getPageThumbnail() {
    const candidates = [
      ['meta[property="og:image:secure_url"]', 'content'],
      ['meta[property="og:image"]', 'content'],
      ['meta[name="twitter:image"]', 'content'],
      ['meta[name="twitter:image:src"]', 'content'],
      ['link[rel="image_src"]', 'href']
    ];

    for (const [selector, attr] of candidates) {
      const raw = document.querySelector(selector)?.getAttribute(attr)?.trim();
      if (!raw) continue;
      try {
        const parsed = new URL(raw, location.href);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return parsed.href;
        }
      } catch {
        // Ignore invalid thumbnail URLs
      }
    }

    return null;
  }

  function captureVideoFrame(video) {
    if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return null;
    }

    try {
      const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      ctx.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      if (!dataUrl || dataUrl.length > MAX_FRAME_DATA_URL_LENGTH) {
        return null;
      }
      return dataUrl;
    } catch {
      // Cross-origin tainted canvas or unsupported codec: ignore silently
      return null;
    }
  }

  function scanVideos() {
    const videos = [];
    const seen = new Set();
    let hasBlobVideo = false;
    let activeMeta = null;

    const videoElements = document.querySelectorAll('video');
    for (const video of videoElements) {
      const width = video.videoWidth || 0;
      const height = video.videoHeight || 0;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
      const isPlaying = !video.paused && !video.ended && video.readyState > 2;
      const poster = video.poster || null;
      const frameThumbnail = captureVideoFrame(video);

      if (!activeMeta && (width > 0 || isPlaying)) {
        activeMeta = { width, height, duration, isPlaying, poster, frameThumbnail };
      }

      const candidateSrcs = [];
      if (video.currentSrc) candidateSrcs.push(video.currentSrc);
      if (video.src && video.src !== video.currentSrc) candidateSrcs.push(video.src);

      for (const source of video.querySelectorAll('source')) {
        if (source.src) candidateSrcs.push(source.src);
      }

      for (const src of candidateSrcs) {
        if (src.startsWith('blob:') || src.startsWith('mediasource:')) {
          hasBlobVideo = true;
          continue;
        }
        if (!src.startsWith('http://') && !src.startsWith('https://')) {
          continue;
        }
        if (seen.has(src)) continue;
        seen.add(src);

        videos.push({
          url: src,
          width,
          height,
          duration,
          isPlaying,
          poster,
          frameThumbnail
        });
      }
    }

    return {
      pageTitle: getSafePageTitle(),
      pageThumbnail: getPageThumbnail(),
      pageUrl: location.href,
      hasBlobVideo,
      activeMeta,
      videos
    };
  }

  window.__freeVideoDownloaderScan = scanVideos;

  let notifyTimer = null;
  function notifyBackground() {
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      const result = scanVideos();
      if (result.videos.length > 0 || result.hasBlobVideo || result.activeMeta) {
        try {
          chrome.runtime.sendMessage({
            type: 'CONTENT_VIDEOS_FOUND',
            payload: result
          }).catch(() => {
            // Extension context may be reloading; ignore safely
          });
        } catch {
          // Extension context invalidated after reload; clean up listeners
          cleanup();
        }
      }
    }, 250);
  }

  function handleMessage(message, _sender, sendResponse) {
    if (message?.type === 'SCAN_PAGE_VIDEOS') {
      sendResponse(scanVideos());
      return false;
    }
    return false;
  }

  function cleanup() {
    listenerController.abort();
    if (notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
    try {
      chrome.runtime.onMessage.removeListener(handleMessage);
    } catch {
      // Ignore invalidated runtime errors
    }
  }

  window.__freeVideoDownloaderCleanup = cleanup;

  const listenerOptions = { capture: true, signal: listenerController.signal };
  document.addEventListener('play', notifyBackground, listenerOptions);
  document.addEventListener('loadedmetadata', notifyBackground, listenerOptions);
  document.addEventListener('loadeddata', notifyBackground, listenerOptions);
  document.addEventListener('seeked', notifyBackground, listenerOptions);

  chrome.runtime.onMessage.addListener(handleMessage);

  // Initial lightweight scan on idle
  notifyBackground();
})();
