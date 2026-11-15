(() => {
  if (window.__freeVideoDownloaderLoaded) return;
  window.__freeVideoDownloaderLoaded = true;

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

      if (!activeMeta && (width > 0 || isPlaying)) {
        activeMeta = { width, height, duration, isPlaying, poster };
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
          poster
        });
      }
    }

    return {
      pageTitle: getSafePageTitle(),
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
        chrome.runtime.sendMessage({
          type: 'CONTENT_VIDEOS_FOUND',
          payload: result
        }).catch(() => {
          // Extension context may be reloading; ignore safely
        });
      }
    }, 250);
  }

  document.addEventListener('play', notifyBackground, true);
  document.addEventListener('loadedmetadata', notifyBackground, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'SCAN_PAGE_VIDEOS') {
      sendResponse(scanVideos());
      return false;
    }
    return false;
  });

  // Initial lightweight scan on idle
  notifyBackground();
})();
