import {
  formatBytes,
  formatDuration,
  getNameFromUrl
} from '../background/media-utils.js';

const elements = {
  videoCount: document.getElementById('video-count'),
  rescanBtn: document.getElementById('rescan-btn'),
  clearBtn: document.getElementById('clear-btn'),
  jobsSection: document.getElementById('jobs-section'),
  jobsList: document.getElementById('jobs-list'),
  clearJobsBtn: document.getElementById('clear-jobs-btn'),
  videosList: document.getElementById('videos-list'),
  emptyState: document.getElementById('empty-state'),
  emptyTitle: document.getElementById('empty-title'),
  emptyDesc: document.getElementById('empty-desc'),
  optSubfolder: document.getElementById('opt-subfolder'),
  optSaveAs: document.getElementById('opt-save-as'),
  statusMessage: document.getElementById('status-message')
};

let currentTab = null;
const inspectedVariantsCache = new Map();

function setStatus(text) {
  elements.statusMessage.textContent = text;
}

function getHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function sortMediaItems(items) {
  const rankKind = { direct: 0, hls: 1, dash: 2 };
  return [...items].sort((a, b) => {
    if (Boolean(b.isPlaying) !== Boolean(a.isPlaying)) {
      return b.isPlaying ? 1 : -1;
    }
    const kindDiff = (rankKind[a.kind] ?? 3) - (rankKind[b.kind] ?? 3);
    if (kindDiff !== 0) return kindDiff;
    if ((b.height || 0) !== (a.height || 0)) {
      return (b.height || 0) - (a.height || 0);
    }
    if ((b.sizeBytes || 0) !== (a.sizeBytes || 0)) {
      return (b.sizeBytes || 0) - (a.sizeBytes || 0);
    }
    return (b.detectedAt || 0) - (a.detectedAt || 0);
  });
}

function createBadge(text, extraClass = '') {
  const span = document.createElement('span');
  span.className = `badge ${extraClass}`.trim();
  span.textContent = text;
  return span;
}

function renderJobs(jobs) {
  elements.jobsList.replaceChildren();
  if (!jobs || jobs.length === 0) {
    elements.jobsSection.hidden = true;
    return;
  }

  elements.jobsSection.hidden = false;
  for (const job of jobs) {
    const li = document.createElement('li');
    li.className = 'job-card';

    const topRow = document.createElement('div');
    topRow.className = 'job-row';

    const name = document.createElement('span');
    name.className = 'job-name';
    name.textContent = job.filename?.split('/').pop() || 'Video stream';

    topRow.appendChild(name);

    const isActive = ['preparing', 'downloading', 'assembling', 'saving'].includes(job.status);
    if (isActive && job.status !== 'saving') {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-ghost btn-xs';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.setAttribute('aria-label', `Cancel download ${name.textContent}`);
      cancelBtn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'CANCEL_HLS_DOWNLOAD', jobId: job.id });
        setStatus('Stream download cancelled.');
      });
      topRow.appendChild(cancelBtn);
    }

    li.appendChild(topRow);

    if (isActive) {
      const progress = document.createElement('progress');
      progress.max = 100;
      progress.value = job.progress || 0;
      li.appendChild(progress);
    }

    const meta = document.createElement('div');
    meta.className = job.status === 'error' ? 'job-error' : 'job-meta';

    if (job.status === 'preparing') {
      meta.textContent = 'Reading stream playlist…';
    } else if (job.status === 'downloading') {
      const sizeStr = formatBytes(job.bytesDownloaded);
      meta.textContent = `Downloading ${job.completedSegments}/${job.totalSegments} parts (${job.progress || 0}%)${sizeStr ? ` · ${sizeStr}` : ''}`;
    } else if (job.status === 'assembling') {
      meta.textContent = 'Combining segments into video file…';
    } else if (job.status === 'saving') {
      meta.textContent = 'Saving to Downloads…';
    } else if (job.status === 'completed') {
      const sizeStr = formatBytes(job.bytesDownloaded);
      meta.textContent = `Saved to Downloads${sizeStr ? ` · ${sizeStr}` : ''}`;
    } else if (job.status === 'cancelled') {
      meta.textContent = 'Cancelled';
    } else if (job.status === 'error') {
      meta.textContent = job.error || 'Download failed.';
    }

    li.appendChild(meta);
    elements.jobsList.appendChild(li);
  }
}

async function copyUrlWithFeedback(url, button) {
  try {
    await navigator.clipboard.writeText(url);
    const original = button.textContent;
    button.textContent = 'Copied';
    setStatus('Video link copied to clipboard.');
    setTimeout(() => {
      button.textContent = original;
    }, 1500);
  } catch {
    setStatus('Could not copy link to clipboard.');
  }
}

function renderVariantsBox(container, item, title, parsed) {
  container.replaceChildren();
  container.hidden = false;

  if (parsed.type === 'master' && parsed.variants.length > 0) {
    const list = document.createElement('ul');
    list.className = 'variants-list';

    let anySeparateAudio = false;
    for (const variant of parsed.variants) {
      if (variant.hasSeparateAudio) anySeparateAudio = true;
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm variant-btn';
      btn.textContent = `Download ${variant.qualityLabel}`;
      btn.setAttribute('aria-label', `Download ${title} in ${variant.qualityLabel}`);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        setStatus(`Starting ${variant.qualityLabel} stream download…`);
        const res = await chrome.runtime.sendMessage({
          type: 'START_HLS_DOWNLOAD',
          url: variant.url,
          title,
          qualityLabel: variant.qualityLabel
        });
        btn.disabled = false;
        if (!res?.ok) {
          setStatus(res?.error || 'Failed to start stream download.');
        } else {
          setStatus(`Downloading ${variant.qualityLabel} stream…`);
        }
      });
      li.appendChild(btn);
      list.appendChild(li);
    }

    container.appendChild(list);
    if (anySeparateAudio) {
      const note = document.createElement('p');
      note.className = 'variant-note';
      note.textContent = 'Note: This stream keeps audio on a separate track; downloaded video may have no sound.';
      container.appendChild(note);
    }
    return;
  }

  // Single media playlist: start directly
  const singleBtn = document.createElement('button');
  singleBtn.type = 'button';
  singleBtn.className = 'btn btn-primary btn-sm';
  const durationStr = formatDuration(parsed.totalDuration);
  singleBtn.textContent = `Download Stream${durationStr ? ` (${durationStr})` : ''}`;
  singleBtn.addEventListener('click', async () => {
    singleBtn.disabled = true;
    const res = await chrome.runtime.sendMessage({
      type: 'START_HLS_DOWNLOAD',
      url: item.url,
      title
    });
    singleBtn.disabled = false;
    if (!res?.ok) {
      setStatus(res?.error || 'Failed to start stream download.');
    }
  });
  container.appendChild(singleBtn);
}

function renderVideos(items, meta) {
  elements.videosList.replaceChildren();
  const sorted = sortMediaItems(items || []);

  const downloadableCount = sorted.length;
  if (downloadableCount === 0) {
    elements.videoCount.textContent = 'No videos found yet';
    elements.emptyState.hidden = false;

    if (meta?.hasBlobVideo) {
      elements.emptyTitle.textContent = 'Protected or streaming-only player detected';
      elements.emptyDesc.textContent =
        'This video uses an encrypted or split browser stream without a direct downloadable file. Try clicking Rescan after playback starts.';
    } else {
      elements.emptyTitle.textContent = 'No videos detected on this tab yet';
      elements.emptyDesc.textContent =
        'Start playing the video for a couple of seconds, then click Rescan.';
    }
    return;
  }

  elements.emptyState.hidden = true;
  elements.videoCount.textContent =
    downloadableCount === 1 ? '1 video detected' : `${downloadableCount} videos detected`;

  const fallbackTitle = meta?.pageTitle || currentTab?.title || '';

  for (const item of sorted) {
    const li = document.createElement('li');
    li.className = 'media-card';

    const displayTitle = item.title || fallbackTitle || getNameFromUrl(item.url);

    const top = document.createElement('div');
    top.className = 'media-top';

    const info = document.createElement('div');
    info.className = 'media-info';

    const titleEl = document.createElement('p');
    titleEl.className = 'media-title';
    titleEl.textContent = displayTitle;
    info.appendChild(titleEl);

    const metaRow = document.createElement('div');
    metaRow.className = 'media-meta';
    metaRow.appendChild(createBadge(item.formatLabel || 'VIDEO'));

    if (item.isPlaying) {
      metaRow.appendChild(createBadge('Playing', 'badge-playing'));
    }

    const activeWidth = item.width || meta?.activeMeta?.width || 0;
    const activeHeight = item.height || meta?.activeMeta?.height || 0;
    if (activeHeight > 0) {
      metaRow.appendChild(createBadge(`${activeHeight}p`));
    } else if (activeWidth > 0) {
      metaRow.appendChild(createBadge(`${activeWidth}px`));
    }

    const sizeStr = formatBytes(item.sizeBytes);
    if (sizeStr) {
      metaRow.appendChild(createBadge(sizeStr));
    }

    const durationVal = item.duration ?? meta?.activeMeta?.duration;
    const durStr = formatDuration(durationVal);
    if (durStr) {
      metaRow.appendChild(createBadge(durStr));
    }

    const host = getHostname(item.url);
    if (host) {
      const hostEl = document.createElement('span');
      hostEl.className = 'media-host';
      hostEl.textContent = host;
      metaRow.appendChild(hostEl);
    }

    info.appendChild(metaRow);
    top.appendChild(info);
    li.appendChild(top);

    const actions = document.createElement('div');
    actions.className = 'media-actions';

    const variantsBox = document.createElement('div');
    variantsBox.className = 'variants-box';
    variantsBox.hidden = true;

    if (item.kind === 'direct') {
      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'btn btn-primary btn-sm';
      dlBtn.textContent = 'Download';
      dlBtn.setAttribute('aria-label', `Download ${displayTitle} (${item.formatLabel})`);
      dlBtn.addEventListener('click', async () => {
        dlBtn.disabled = true;
        setStatus('Starting download…');
        const res = await chrome.runtime.sendMessage({
          type: 'START_DIRECT_DOWNLOAD',
          url: item.url,
          title: displayTitle,
          ext: item.ext
        });
        dlBtn.disabled = false;
        if (res?.ok) {
          dlBtn.textContent = 'Saved!';
          setStatus(`Downloading ${res.filename}`);
          setTimeout(() => {
            dlBtn.textContent = 'Download';
          }, 1800);
        } else {
          setStatus(res?.error || 'Download failed.');
        }
      });
      actions.appendChild(dlBtn);
    } else if (item.kind === 'hls') {
      const dlBestBtn = document.createElement('button');
      dlBestBtn.type = 'button';
      dlBestBtn.className = 'btn btn-primary btn-sm';
      dlBestBtn.textContent = 'Download';
      dlBestBtn.setAttribute('aria-label', `Download ${displayTitle} HLS stream`);
      dlBestBtn.addEventListener('click', async () => {
        dlBestBtn.disabled = true;
        setStatus('Preparing HLS stream…');
        const res = await chrome.runtime.sendMessage({
          type: 'START_HLS_DOWNLOAD',
          url: item.url,
          title: displayTitle
        });
        dlBestBtn.disabled = false;
        if (!res?.ok) {
          setStatus(res?.error || 'Could not start stream download.');
        } else {
          setStatus('Downloading stream segments…');
        }
      });
      actions.appendChild(dlBestBtn);

      const qualitiesBtn = document.createElement('button');
      qualitiesBtn.type = 'button';
      qualitiesBtn.className = 'btn btn-secondary btn-sm';
      qualitiesBtn.textContent = 'Qualities';
      qualitiesBtn.setAttribute('aria-label', `Choose quality for ${displayTitle}`);
      qualitiesBtn.addEventListener('click', async () => {
        if (!variantsBox.hidden) {
          variantsBox.hidden = true;
          return;
        }
        if (inspectedVariantsCache.has(item.url)) {
          renderVariantsBox(variantsBox, item, displayTitle, inspectedVariantsCache.get(item.url));
          return;
        }
        qualitiesBtn.disabled = true;
        qualitiesBtn.textContent = 'Loading…';
        const res = await chrome.runtime.sendMessage({ type: 'INSPECT_HLS', url: item.url });
        qualitiesBtn.disabled = false;
        qualitiesBtn.textContent = 'Qualities';
        if (res?.ok && res.parsed) {
          inspectedVariantsCache.set(item.url, res.parsed);
          renderVariantsBox(variantsBox, item, displayTitle, res.parsed);
        } else {
          setStatus(res?.error || 'Could not inspect stream qualities.');
        }
      });
      actions.appendChild(qualitiesBtn);
    } else if (item.kind === 'dash') {
      const noteBadge = createBadge('Split DASH stream', 'badge-warn');
      actions.appendChild(noteBadge);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-secondary btn-sm';
    copyBtn.textContent = 'Copy URL';
    copyBtn.setAttribute('aria-label', `Copy video link for ${displayTitle}`);
    copyBtn.addEventListener('click', () => copyUrlWithFeedback(item.url, copyBtn));
    actions.appendChild(copyBtn);

    li.appendChild(actions);
    li.appendChild(variantsBox);
    elements.videosList.appendChild(li);
  }
}

async function refreshState() {
  if (!currentTab) return;
  const state = await chrome.runtime.sendMessage({
    type: 'GET_TAB_STATE',
    tabId: currentTab.id
  });

  if (!state) return;

  elements.optSubfolder.checked = Boolean(state.settings?.subfolder);
  elements.optSaveAs.checked = Boolean(state.settings?.saveAs);

  renderJobs(state.jobs);
  renderVideos(state.items, state.meta);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;

  if (!currentTab || !currentTab.url || (!currentTab.url.startsWith('http://') && !currentTab.url.startsWith('https://'))) {
    elements.videoCount.textContent = 'Open a video webpage';
    elements.rescanBtn.disabled = true;
    elements.clearBtn.disabled = true;
    elements.emptyState.hidden = false;
    elements.emptyTitle.textContent = 'Not a standard webpage';
    elements.emptyDesc.textContent = 'Switch to a tab with a playing video, then open this extension again.';
    return;
  }

  await refreshState();

  // Trigger a lightweight page scan so already-loaded <video> tags appear immediately
  chrome.runtime.sendMessage({ type: 'RESCAN_TAB', tabId: currentTab.id }).catch(() => {});
}

elements.rescanBtn.addEventListener('click', async () => {
  if (!currentTab) return;
  elements.rescanBtn.disabled = true;
  setStatus('Scanning page for videos…');
  const res = await chrome.runtime.sendMessage({ type: 'RESCAN_TAB', tabId: currentTab.id });
  elements.rescanBtn.disabled = false;
  await refreshState();
  setStatus(res?.ok ? 'Page scan complete.' : (res?.error || 'Could not scan this page.'));
});

elements.clearBtn.addEventListener('click', async () => {
  if (!currentTab) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_TAB_MEDIA', tabId: currentTab.id });
  await refreshState();
  setStatus('Cleared detected videos for this tab.');
});

elements.clearJobsBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_FINISHED_JOBS' });
  await refreshState();
});

elements.optSubfolder.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    settings: { subfolder: elements.optSubfolder.checked ? 'Video Downloader' : '' }
  });
  setStatus('Download folder setting saved.');
});

elements.optSaveAs.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    settings: { saveAs: elements.optSaveAs.checked }
  });
  setStatus('Save prompt setting saved.');
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'session' && (changes.tabMedia || changes.tabMeta || changes.downloadJobs)) {
    refreshState().catch(() => {});
  }
});

init().catch(() => {
  setStatus('Could not load extension state.');
});
