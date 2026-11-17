import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the daemon keeps its descriptor, log and start lock. */
export function stateDir() {
  const dir = process.env.AGENTBUS_HOME
    ? path.resolve(process.env.AGENTBUS_HOME)
    : path.join(os.homedir(), '.agentbus');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function daemonInfoPath() {
  return path.join(stateDir(), 'daemon.json');
}

export function daemonLogPath() {
  return path.join(stateDir(), 'daemon.log');
}

export function lockPath() {
  return path.join(stateDir(), 'start.lock');
}

export function readDaemonInfo() {
  try {
    return JSON.parse(fs.readFileSync(daemonInfoPath(), 'utf8'));
  } catch {
    return null;
  }
}

/** Descriptor holds the local auth token, so keep it private to the user. */
export function writeDaemonInfo(info) {
  const file = daemonInfoPath();
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

export function clearDaemonInfo(pid) {
  const info = readDaemonInfo();
  if (!info) return;
  if (pid != null && info.pid !== pid) return;
  try {
    fs.unlinkSync(daemonInfoPath());
  } catch {
    /* already gone */
  }
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
