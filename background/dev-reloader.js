const DEV_RELOAD_SERVER_URL = 'http://127.0.0.1:41937';
const KEEPALIVE_ALARM_NAME = 'dev-reload-keepalive';
const KEEPALIVE_PERIOD_MINUTES = 0.5;
const SETTINGS_STORAGE_KEY = 'userSettings';
const STATE_STORAGE_KEY = 'devReloadState';
const VERSION_TIMEOUT_MS = 2500;
const WAIT_TIMEOUT_MS = 30000;

let enabled = true;
let serverReachable = false;
let pollLoopActive = false;
let checkInFlight = false;
let alarmListenerRegistered = false;
let activeAbortController = null;
let loopGeneration = 0;

let currentInstanceId = null;
let currentBuildId = null;
let lastCheckedAt = null;

function fetchWithTimeout(url, timeoutMs, externalSignal = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let onExternalAbort = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId);
      controller.abort();
    } else {
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return fetch(url, {
    method: 'GET',
    cache: 'no-store',
    signal: controller.signal
  }).finally(() => {
    clearTimeout(timeoutId);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  });
}

async function readAutoReloadEnabled() {
  try {
    const data = await chrome.storage.local.get({
      [SETTINGS_STORAGE_KEY]: { autoReload: true }
    });
    const settings = data?.[SETTINGS_STORAGE_KEY];
    return settings?.autoReload !== false;
  } catch {
    return true;
  }
}

async function readStoredState() {
  try {
    const data = await chrome.storage.local.get({ [STATE_STORAGE_KEY]: null });
    return data?.[STATE_STORAGE_KEY] || null;
  } catch {
    return null;
  }
}

async function saveStoredState(instanceId, buildId) {
  currentInstanceId = instanceId;
  currentBuildId = buildId;
  try {
    await chrome.storage.local.set({
      [STATE_STORAGE_KEY]: { instanceId, buildId }
    });
  } catch {
    // Ignore storage write failures during shutdown/reload
  }
}

async function ensureKeepaliveAlarm() {
  if (!chrome?.alarms) return;
  try {
    const existing = await chrome.alarms.get(KEEPALIVE_ALARM_NAME);
    if (!existing) {
      chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
        periodInMinutes: KEEPALIVE_PERIOD_MINUTES
      });
    }
  } catch {
    // Ignore alarm registration errors
  }
}

async function clearKeepaliveAlarm() {
  if (!chrome?.alarms) return;
  try {
    await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
  } catch {
    // Ignore alarm clear errors
  }
}

function abortActiveRequests() {
  loopGeneration += 1;
  if (activeAbortController) {
    try {
      activeAbortController.abort();
    } catch {
      // Ignore abort errors
    }
    activeAbortController = null;
  }
}

async function triggerExtensionReload(instanceId, buildId) {
  await saveStoredState(instanceId, buildId);
  abortActiveRequests();
  try {
    chrome.runtime.reload();
  } catch {
    // Ignore if runtime is already reloading
  }
}

async function runWaitLoop(myGeneration) {
  pollLoopActive = true;
  try {
    while (enabled && myGeneration === loopGeneration) {
      activeAbortController = new AbortController();
      const waitUrl =
        `${DEV_RELOAD_SERVER_URL}/wait` +
        `?since=${encodeURIComponent(String(currentBuildId ?? 0))}` +
        `&instance=${encodeURIComponent(String(currentInstanceId ?? ''))}`;

      const response = await fetchWithTimeout(
        waitUrl,
        WAIT_TIMEOUT_MS,
        activeAbortController.signal
      );
      activeAbortController = null;

      if (!enabled || myGeneration !== loopGeneration) {
        return;
      }
      if (!response.ok) {
        serverReachable = false;
        return;
      }

      const data = await response.json();
      lastCheckedAt = Date.now();
      if (!data || typeof data.instanceId !== 'string' || typeof data.buildId !== 'number') {
        serverReachable = false;
        return;
      }

      serverReachable = true;

      if (!enabled || myGeneration !== loopGeneration) {
        return;
      }

      if (data.instanceId !== currentInstanceId) {
        await saveStoredState(data.instanceId, data.buildId);
        continue;
      }

      if (data.buildId > Number(currentBuildId ?? 0)) {
        await triggerExtensionReload(data.instanceId, data.buildId);
        return;
      }
    }
  } catch {
    // Server offline, restarted, or request aborted; wait for next alarm tick.
    serverReachable = false;
  } finally {
    activeAbortController = null;
    pollLoopActive = false;
  }
}

async function checkAndStartPolling() {
  if (!enabled || checkInFlight || pollLoopActive) {
    return;
  }

  checkInFlight = true;
  const myGeneration = loopGeneration;

  try {
    activeAbortController = new AbortController();
    const response = await fetchWithTimeout(
      `${DEV_RELOAD_SERVER_URL}/version`,
      VERSION_TIMEOUT_MS,
      activeAbortController.signal
    );
    activeAbortController = null;

    if (!enabled || myGeneration !== loopGeneration) {
      return;
    }
    if (!response.ok) {
      serverReachable = false;
      return;
    }

    const version = await response.json();
    lastCheckedAt = Date.now();

    if (
      !version ||
      typeof version.instanceId !== 'string' ||
      typeof version.buildId !== 'number'
    ) {
      serverReachable = false;
      return;
    }

    serverReachable = true;
    const stored = await readStoredState();

    if (!enabled || myGeneration !== loopGeneration) {
      return;
    }

    if (!stored || stored.instanceId !== version.instanceId) {
      await saveStoredState(version.instanceId, version.buildId);
    } else if (version.buildId > Number(stored.buildId ?? 0)) {
      await triggerExtensionReload(version.instanceId, version.buildId);
      return;
    } else {
      currentInstanceId = stored.instanceId;
      currentBuildId = stored.buildId;
    }

    checkInFlight = false;
    await runWaitLoop(myGeneration);
  } catch {
    // Dev server is not running; stay quiet and wait for next alarm tick.
    serverReachable = false;
  } finally {
    activeAbortController = null;
    checkInFlight = false;
  }
}

function registerAlarmListener() {
  if (alarmListenerRegistered) return;
  if (typeof chrome === 'undefined' || !chrome.alarms?.onAlarm) return;

  alarmListenerRegistered = true;
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== KEEPALIVE_ALARM_NAME) return;
    if (!enabled) return;
    void checkAndStartPolling();
  });
}

/**
 * Initialize the local dev auto-reloader for the extension service worker.
 */
export async function initDevReloader() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;

  registerAlarmListener();
  enabled = await readAutoReloadEnabled();

  if (!enabled) {
    abortActiveRequests();
    await clearKeepaliveAlarm();
    return;
  }

  await ensureKeepaliveAlarm();
  void checkAndStartPolling();
}

/**
 * Enable or disable automatic reloading when local extension files change.
 * @param {boolean} nextEnabled
 */
export async function setDevReloadEnabled(nextEnabled) {
  enabled = Boolean(nextEnabled);

  if (!enabled) {
    abortActiveRequests();
    serverReachable = false;
    await clearKeepaliveAlarm();
    return;
  }

  registerAlarmListener();
  await ensureKeepaliveAlarm();
  void checkAndStartPolling();
}

/**
 * Return current diagnostic status for the dev auto-reloader.
 */
export function getDevReloadStatus() {
  return {
    enabled,
    connected: serverReachable,
    polling: pollLoopActive,
    serverUrl: DEV_RELOAD_SERVER_URL,
    instanceId: currentInstanceId,
    buildId: currentBuildId,
    lastCheckedAt
  };
}
