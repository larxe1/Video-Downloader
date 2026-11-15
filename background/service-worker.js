import {
  classifyMediaRequest,
  getDedupeKey,
  getNameFromUrl,
  parseM3u8,
  sanitizeFilename
} from './media-utils.js';

const STORAGE_KEYS = {
  TAB_MEDIA: 'tabMedia',
  TAB_META: 'tabMeta',
  JOBS: 'downloadJobs',
  BLOB_MAP: 'blobDownloadMap',
  SETTINGS: 'userSettings'
};

const DEFAULT_SETTINGS = {
  subfolder: 'Video Downloader',
  saveAs: false
};

const MAX_ITEMS_PER_TAB = 40;

// In-tick promise chain to serialize chrome.storage.session updates without losing concurrent events.
// Never caches state across service worker restarts — every operation reads fresh from chrome.storage.
let storageQueue = Promise.resolve();
function serializeStorageOp(fn) {
  const next = storageQueue.then(fn, fn);
  storageQueue = next.catch(() => {});
  return next;
}

function getHeader(headers, name) {
  if (!Array.isArray(headers)) return '';
  const target = name.toLowerCase();
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === target) {
      return h.value || '';
    }
  }
  return '';
}

async function getSettings() {
  const data = await chrome.storage.local.get({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...data[STORAGE_KEYS.SETTINGS] };
}

async function updateBadge(tabId, count) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#0078D4', tabId });
    await chrome.action.setBadgeText({
      text: count > 0 ? String(Math.min(count, 99)) : '',
      tabId
    });
  } catch {
    // Tab may have closed before badge update completed
  }
}

async function upsertTabMedia(tabId, newItems, metaPatch = null) {
  if (typeof tabId !== 'number' || tabId < 0) return;

  const updatedCount = await serializeStorageOp(async () => {
    const data = await chrome.storage.session.get({
      [STORAGE_KEYS.TAB_MEDIA]: {},
      [STORAGE_KEYS.TAB_META]: {}
    });

    const allMedia = data[STORAGE_KEYS.TAB_MEDIA];
    const allMeta = data[STORAGE_KEYS.TAB_META];
    const key = String(tabId);
    const list = Array.isArray(allMedia[key]) ? [...allMedia[key]] : [];

    for (const item of newItems) {
      const existingIdx = list.findIndex((x) => x.dedupeKey === item.dedupeKey);
      if (existingIdx >= 0) {
        const prev = list[existingIdx];
        list[existingIdx] = {
          ...prev,
          ...item,
          title: item.title || prev.title,
          sizeBytes: item.sizeBytes ?? prev.sizeBytes,
          width: item.width || prev.width,
          height: item.height || prev.height,
          duration: item.duration ?? prev.duration,
          isPlaying: item.isPlaying ?? prev.isPlaying,
          detectedAt: Math.max(prev.detectedAt || 0, item.detectedAt || 0)
        };
      } else {
        list.unshift(item);
      }
    }

    if (list.length > MAX_ITEMS_PER_TAB) {
      list.length = MAX_ITEMS_PER_TAB;
    }

    allMedia[key] = list;

    if (metaPatch) {
      allMeta[key] = { ...(allMeta[key] || {}), ...metaPatch };
    }

    await chrome.storage.session.set({
      [STORAGE_KEYS.TAB_MEDIA]: allMedia,
      [STORAGE_KEYS.TAB_META]: allMeta
    });

    return list.length;
  });

  await updateBadge(tabId, updatedCount);
}

async function clearTabMedia(tabId) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  await serializeStorageOp(async () => {
    const data = await chrome.storage.session.get({
      [STORAGE_KEYS.TAB_MEDIA]: {},
      [STORAGE_KEYS.TAB_META]: {}
    });
    const key = String(tabId);
    delete data[STORAGE_KEYS.TAB_MEDIA][key];
    delete data[STORAGE_KEYS.TAB_META][key];
    await chrome.storage.session.set({
      [STORAGE_KEYS.TAB_MEDIA]: data[STORAGE_KEYS.TAB_MEDIA],
      [STORAGE_KEYS.TAB_META]: data[STORAGE_KEYS.TAB_META]
    });
  });
  await updateBadge(tabId, 0);
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Download and assemble HLS video segments into a single video file.'
  });
}

async function updateDownloadJob(jobId, patch) {
  return serializeStorageOp(async () => {
    const data = await chrome.storage.session.get({ [STORAGE_KEYS.JOBS]: {} });
    const jobs = data[STORAGE_KEYS.JOBS];
    const current = jobs[jobId] || { id: jobId };
    jobs[jobId] = { ...current, ...patch, updatedAt: Date.now() };

    // Keep job history concise
    const entries = Object.values(jobs).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (entries.length > 12) {
      const trimmed = {};
      for (const item of entries.slice(0, 12)) {
        trimmed[item.id] = item;
      }
      await chrome.storage.session.set({ [STORAGE_KEYS.JOBS]: trimmed });
      return trimmed[jobId];
    }

    await chrome.storage.session.set({ [STORAGE_KEYS.JOBS]: jobs });
    return jobs[jobId];
  });
}

async function inspectHlsVariants(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Could not inspect stream (HTTP ${res.status})`);
  }
  const text = await res.text();
  const parsed = parseM3u8(text, res.url || url);
  return parsed;
}

async function startDirectDownload({ url, title, ext }) {
  const settings = await getSettings();
  const filename = sanitizeFilename(
    title || getNameFromUrl(url),
    ext || 'mp4',
    settings.subfolder
  );

  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: Boolean(settings.saveAs)
  });

  return { downloadId, filename };
}

async function startHlsDownload({ url, title, qualityLabel }) {
  const settings = await getSettings();
  const label = qualityLabel ? `${title || getNameFromUrl(url)} (${qualityLabel})` : (title || getNameFromUrl(url));
  const baseFilename = sanitizeFilename(label, 'mp4', settings.subfolder);
  const jobId = `hls_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await updateDownloadJob(jobId, {
    id: jobId,
    url,
    filename: baseFilename,
    status: 'preparing',
    progress: 0,
    completedSegments: 0,
    totalSegments: 0,
    bytesDownloaded: 0,
    error: null
  });

  await ensureOffscreenDocument();

  await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_DOWNLOAD_HLS',
    jobId,
    url,
    baseFilename
  });

  return { jobId, filename: baseFilename };
}

// --- Top-level synchronous MV3 event registrations ---

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.statusCode < 200 || details.statusCode >= 400) return;

    const contentType = getHeader(details.responseHeaders, 'content-type');
    const contentLengthRaw = getHeader(details.responseHeaders, 'content-length');
    const contentRange = getHeader(details.responseHeaders, 'content-range');
    const contentLength = contentLengthRaw ? Number(contentLengthRaw) : null;

    const classified = classifyMediaRequest({
      url: details.url,
      contentType,
      contentLength,
      contentRange
    });

    if (!classified) return;

    upsertTabMedia(details.tabId, [
      {
        id: `${classified.kind}_${classified.dedupeKey}`,
        url: details.url,
        dedupeKey: classified.dedupeKey,
        kind: classified.kind,
        ext: classified.ext,
        formatLabel: classified.formatLabel,
        mimeType: classified.mimeType,
        sizeBytes: classified.sizeBytes,
        source: 'network',
        detectedAt: Date.now()
      }
    ]).catch(() => {});
  },
  {
    urls: ['<all_urls>'],
    types: ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'other']
  },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabMedia(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    const data = await chrome.storage.session.get({ [STORAGE_KEYS.TAB_META]: {} });
    const prevUrl = data[STORAGE_KEYS.TAB_META]?.[String(tabId)]?.lastMainUrl;
    const prevBase = prevUrl ? prevUrl.split('#')[0] : '';
    const nextBase = changeInfo.url.split('#')[0];

    if (prevBase !== nextBase) {
      await clearTabMedia(tabId);
      await upsertTabMedia(tabId, [], { lastMainUrl: changeInfo.url });
    }
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || (delta.state.current !== 'complete' && delta.state.current !== 'interrupted')) {
    return;
  }

  serializeStorageOp(async () => {
    const data = await chrome.storage.session.get({ [STORAGE_KEYS.BLOB_MAP]: {} });
    const blobMap = data[STORAGE_KEYS.BLOB_MAP];
    const entry = blobMap[String(delta.id)];
    if (!entry) return;

    delete blobMap[String(delta.id)];
    await chrome.storage.session.set({ [STORAGE_KEYS.BLOB_MAP]: blobMap });

    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_REVOKE_BLOB',
      jobId: entry.jobId,
      blobUrl: entry.blobUrl
    }).catch(() => {});

    if (entry.jobId) {
      const jobsData = await chrome.storage.session.get({ [STORAGE_KEYS.JOBS]: {} });
      const jobs = jobsData[STORAGE_KEYS.JOBS];
      if (jobs[entry.jobId]) {
        jobs[entry.jobId] = {
          ...jobs[entry.jobId],
          status: delta.state.current === 'complete' ? 'completed' : 'error',
          error: delta.state.current === 'interrupted' ? 'Browser download was interrupted.' : null,
          updatedAt: Date.now()
        };
        await chrome.storage.session.set({ [STORAGE_KEYS.JOBS]: jobs });
      }
    }
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'CONTENT_VIDEOS_FOUND': {
        const tabId = sender.tab?.id;
        if (typeof tabId !== 'number' || tabId < 0) {
          sendResponse({ ok: false });
          return;
        }
        const payload = message.payload || {};
        const items = (payload.videos || []).map((v) => {
          const classified = classifyMediaRequest({ url: v.url }) || {
            kind: 'direct',
            ext: 'mp4',
            formatLabel: 'VIDEO',
            mimeType: 'video/mp4',
            sizeBytes: null,
            dedupeKey: getDedupeKey(v.url)
          };
          return {
            id: `${classified.kind}_${classified.dedupeKey}`,
            url: v.url,
            dedupeKey: classified.dedupeKey,
            kind: classified.kind,
            ext: classified.ext,
            formatLabel: classified.formatLabel,
            mimeType: classified.mimeType,
            sizeBytes: classified.sizeBytes,
            width: v.width || 0,
            height: v.height || 0,
            duration: v.duration ?? null,
            isPlaying: Boolean(v.isPlaying),
            poster: v.poster || null,
            title: payload.pageTitle || '',
            source: 'dom',
            detectedAt: Date.now()
          };
        });

        await upsertTabMedia(tabId, items, {
          pageTitle: payload.pageTitle || '',
          hasBlobVideo: Boolean(payload.hasBlobVideo),
          activeMeta: payload.activeMeta || null,
          lastMainUrl: sender.tab?.url || undefined
        });

        sendResponse({ ok: true });
        return;
      }

      case 'GET_TAB_STATE': {
        const tabId = message.tabId;
        const data = await chrome.storage.session.get({
          [STORAGE_KEYS.TAB_MEDIA]: {},
          [STORAGE_KEYS.TAB_META]: {},
          [STORAGE_KEYS.JOBS]: {}
        });
        const settings = await getSettings();
        const key = String(tabId);
        sendResponse({
          items: data[STORAGE_KEYS.TAB_MEDIA][key] || [],
          meta: data[STORAGE_KEYS.TAB_META][key] || {},
          jobs: Object.values(data[STORAGE_KEYS.JOBS] || {}).sort(
            (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
          ),
          settings
        });
        return;
      }

      case 'RESCAN_TAB': {
        const tabId = message.tabId;
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ['content/content.js']
          });

          const frameResults = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => (typeof window.__freeVideoDownloaderScan === 'function' ? window.__freeVideoDownloaderScan() : null)
          });

          let mergedItems = [];
          let mergedMeta = {};
          for (const frame of frameResults || []) {
            const p = frame?.result;
            if (!p) continue;
            if (p.pageTitle && !mergedMeta.pageTitle) mergedMeta.pageTitle = p.pageTitle;
            if (p.hasBlobVideo) mergedMeta.hasBlobVideo = true;
            if (p.activeMeta && !mergedMeta.activeMeta) mergedMeta.activeMeta = p.activeMeta;

            for (const v of p.videos || []) {
              const classified = classifyMediaRequest({ url: v.url }) || {
                kind: 'direct',
                ext: 'mp4',
                formatLabel: 'VIDEO',
                mimeType: 'video/mp4',
                sizeBytes: null,
                dedupeKey: getDedupeKey(v.url)
              };
              mergedItems.push({
                id: `${classified.kind}_${classified.dedupeKey}`,
                url: v.url,
                dedupeKey: classified.dedupeKey,
                kind: classified.kind,
                ext: classified.ext,
                formatLabel: classified.formatLabel,
                mimeType: classified.mimeType,
                sizeBytes: v.sizeBytes ?? classified.sizeBytes,
                width: v.width || 0,
                height: v.height || 0,
                duration: v.duration ?? null,
                isPlaying: Boolean(v.isPlaying),
                poster: v.poster || null,
                title: p.pageTitle || '',
                source: 'dom',
                detectedAt: Date.now()
              });
            }
          }

          await upsertTabMedia(tabId, mergedItems, mergedMeta);
          sendResponse({ ok: true, frames: frameResults?.length || 0 });
        } catch (err) {
          sendResponse({ ok: false, error: err?.message || 'Cannot scan restricted page.' });
        }
        return;
      }

      case 'CLEAR_TAB_MEDIA': {
        await clearTabMedia(message.tabId);
        sendResponse({ ok: true });
        return;
      }

      case 'START_DIRECT_DOWNLOAD': {
        const res = await startDirectDownload(message);
        sendResponse({ ok: true, ...res });
        return;
      }

      case 'INSPECT_HLS': {
        const parsed = await inspectHlsVariants(message.url);
        sendResponse({ ok: true, parsed });
        return;
      }

      case 'START_HLS_DOWNLOAD': {
        const res = await startHlsDownload(message);
        sendResponse({ ok: true, ...res });
        return;
      }

      case 'CANCEL_HLS_DOWNLOAD': {
        await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_CANCEL_HLS',
          jobId: message.jobId
        }).catch(() => {});
        await updateDownloadJob(message.jobId, { status: 'cancelled' });
        sendResponse({ ok: true });
        return;
      }

      case 'CLEAR_FINISHED_JOBS': {
        await serializeStorageOp(async () => {
          const data = await chrome.storage.session.get({ [STORAGE_KEYS.JOBS]: {} });
          const remaining = {};
          for (const [id, job] of Object.entries(data[STORAGE_KEYS.JOBS] || {})) {
            if (job.status === 'preparing' || job.status === 'downloading' || job.status === 'assembling') {
              remaining[id] = job;
            }
          }
          await chrome.storage.session.set({ [STORAGE_KEYS.JOBS]: remaining });
        });
        sendResponse({ ok: true });
        return;
      }

      case 'SAVE_SETTINGS': {
        const current = await getSettings();
        const updated = { ...current, ...(message.settings || {}) };
        await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updated });
        sendResponse({ ok: true, settings: updated });
        return;
      }

      case 'HLS_PROGRESS': {
        await updateDownloadJob(message.jobId, {
          status: message.status,
          progress: message.progress ?? 0,
          completedSegments: message.completedSegments ?? 0,
          totalSegments: message.totalSegments ?? 0,
          bytesDownloaded: message.bytesDownloaded ?? 0,
          isLive: Boolean(message.isLive)
        });
        sendResponse({ ok: true });
        return;
      }

      case 'HLS_READY': {
        const settings = await getSettings();
        const downloadId = await chrome.downloads.download({
          url: message.blobUrl,
          filename: message.filename,
          saveAs: Boolean(settings.saveAs)
        });
        await serializeStorageOp(async () => {
          const data = await chrome.storage.session.get({ [STORAGE_KEYS.BLOB_MAP]: {} });
          const blobMap = data[STORAGE_KEYS.BLOB_MAP];
          blobMap[String(downloadId)] = {
            jobId: message.jobId,
            blobUrl: message.blobUrl
          };
          await chrome.storage.session.set({ [STORAGE_KEYS.BLOB_MAP]: blobMap });
        });
        await updateDownloadJob(message.jobId, {
          status: 'saving',
          filename: message.filename,
          bytesDownloaded: message.byteLength,
          progress: 100
        });
        sendResponse({ ok: true });
        return;
      }

      case 'HLS_ERROR': {
        await updateDownloadJob(message.jobId, {
          status: 'error',
          error: message.error || 'Download failed.'
        });
        sendResponse({ ok: true });
        return;
      }

      case 'HLS_CANCELLED': {
        await updateDownloadJob(message.jobId, {
          status: 'cancelled'
        });
        sendResponse({ ok: true });
        return;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: err?.message || 'Unexpected error' });
  });

  return true;
});
