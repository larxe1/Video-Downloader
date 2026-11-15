import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 41937;
const DEBOUNCE_MS = 250;
const LONG_POLL_TIMEOUT_MS = 25000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'tests', 'scripts']);
const IGNORED_FILES = new Set(['.gitignore', 'readme.md', 'package.json']);

const instanceId = crypto.randomUUID();
let buildId = 1;
let changedAt = new Date().toISOString();
let debounceTimer = null;
let lastChangedFile = null;

/** @type {Set<{ res: http.ServerResponse, timer: NodeJS.Timeout }>} */
const waiters = new Set();

function shouldIgnorePath(rawFilename) {
  if (!rawFilename) return true;
  const normalized = String(rawFilename).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) return true;

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return true;

  for (const segment of segments) {
    if (IGNORED_DIRS.has(segment.toLowerCase())) {
      return true;
    }
  }

  const baseName = segments[segments.length - 1].toLowerCase();
  if (IGNORED_FILES.has(baseName)) {
    return true;
  }
  if (baseName.endsWith('.bat')) {
    return true;
  }

  return false;
}

function getPayload() {
  return {
    instanceId,
    buildId,
    changedAt
  };
}

function sendJson(res, statusCode, data) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function flushWaiters() {
  if (waiters.size === 0) return;
  const payload = getPayload();
  for (const waiter of Array.from(waiters)) {
    waiters.delete(waiter);
    clearTimeout(waiter.timer);
    sendJson(waiter.res, 200, payload);
  }
}

function scheduleRebuild(filename) {
  lastChangedFile = String(filename).replace(/\\/g, '/');
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    buildId += 1;
    changedAt = new Date().toISOString();
    const label = lastChangedFile ? ` (${lastChangedFile})` : '';
    console.log(
      `[Auto-Reload] Change detected${label} -> reloading extension in Edge (build #${buildId})`
    );
    flushWaiters();
  }, DEBOUNCE_MS);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'no-store'
    });
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const requestUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (requestUrl.pathname === '/version') {
    sendJson(res, 200, getPayload());
    return;
  }

  if (requestUrl.pathname === '/wait') {
    const sinceParam = requestUrl.searchParams.get('since');
    const since = sinceParam !== null ? Number(sinceParam) : NaN;
    const clientInstance = requestUrl.searchParams.get('instance') || '';

    const instanceMismatch = clientInstance !== instanceId;
    const hasNewerBuild = Number.isFinite(since) && buildId > since;

    if (instanceMismatch || hasNewerBuild) {
      sendJson(res, 200, getPayload());
      return;
    }

    const waiter = {
      res,
      timer: null
    };

    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      sendJson(res, 200, getPayload());
    }, LONG_POLL_TIMEOUT_MS);

    waiters.add(waiter);

    req.on('close', () => {
      if (waiters.has(waiter)) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
      }
    });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

let watcher = null;

function shutdown() {
  console.log('\n[Auto-Reload] Stopping auto-reload server...');
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  for (const waiter of Array.from(waiters)) {
    waiters.delete(waiter);
    clearTimeout(waiter.timer);
    if (!waiter.res.writableEnded) {
      waiter.res.destroy();
    }
  }
  if (watcher) {
    try {
      watcher.close();
    } catch {
      // Ignore close errors during shutdown
    }
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 500).unref();
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`[Auto-Reload] Port ${PORT} on ${HOST} is already in use.`);
    console.error(
      '[Auto-Reload] Another auto-reload window is probably already running.'
    );
    console.error(
      '[Auto-Reload] Close the other window first if you want to restart it.'
    );
    console.error('');
    process.exit(1);
  }
  console.error('[Auto-Reload] Server error:', err?.message || err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  try {
    watcher = fs.watch(ROOT_DIR, { recursive: true }, (_eventType, filename) => {
      if (shouldIgnorePath(filename)) return;
      scheduleRebuild(filename);
    });
    watcher.on('error', (err) => {
      console.error('[Auto-Reload] File watcher error:', err?.message || err);
    });
  } catch (err) {
    console.error(
      '[Auto-Reload] Could not watch project folder:',
      err?.message || err
    );
    process.exit(1);
  }

  console.log('');
  console.log('==========================================================');
  console.log(' Free Video Downloader - Auto-Reload Server is RUNNING');
  console.log('==========================================================');
  console.log(` Watching folder : ${ROOT_DIR}`);
  console.log(` Listening on    : http://${HOST}:${PORT}`);
  console.log('');
  console.log(' Whenever you edit and save an extension file, Microsoft Edge');
  console.log(' will reload Free Video Downloader automatically.');
  console.log(' Leave this window open while editing. Press Ctrl+C to stop.');
  console.log('');
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
