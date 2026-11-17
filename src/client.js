import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as paths from './paths.js';

const DAEMON_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function request(info, method, routePath, body, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}${routePath}`, {
      method,
      headers: {
        'x-agentbus-token': info.token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { error: text.slice(0, 500) };
    }
    if (!res.ok) {
      const err = new Error(payload?.error || `${method} ${routePath} failed with ${res.status}`);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function ping(info, timeoutMs = 700) {
  if (!info?.port || !info?.token) return false;
  try {
    await request(info, 'GET', '/api/health', null, { timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** Reach a live daemon, starting one detached if needed. */
export async function ensureDaemon() {
  let info = paths.readDaemonInfo();
  if (await ping(info)) return info;

  if (info?.pid && !paths.isAlive(info.pid)) paths.clearDaemonInfo(info.pid);
  if (await ping(paths.readDaemonInfo())) return paths.readDaemonInfo();

  return startDetached();
}

async function startDetached(attempt = 0) {
  const lockFile = paths.lockPath();
  let acquired = false;
  try {
    const fd = fs.openSync(lockFile, 'wx', 0o600);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    acquired = true;
  } catch {
    // Another process is starting the daemon right now; wait for it.
  }

  if (!acquired) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const info = paths.readDaemonInfo();
      if (await ping(info)) return info;
      await delay(120);
    }
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* already gone */
    }
    if (attempt >= 1) throw new Error('agentbus daemon did not come up');
    return startDetached(attempt + 1);
  }

  let child;
  let logFd;
  try {
    logFd = fs.openSync(paths.daemonLogPath(), 'a');
    child = spawn(process.execPath, [DAEMON_SCRIPT], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: paths.stateDir(),
      env: process.env,
    });
    child.unref();

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const info = paths.readDaemonInfo();
      if (info?.pid === child.pid && (await ping(info))) return info;
      if (child.exitCode != null) break;
      await delay(80);
    }
  } finally {
    if (logFd != null) {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* ignore */
    }
  }

  throw new Error(`agentbus daemon failed to start — see ${paths.daemonLogPath()}`);
}
