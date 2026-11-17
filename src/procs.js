import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { detectProject } from './project.js';

/** Executable names that mean "an agent is running" (matched exactly). */
const TOOLS = new Set(['freebuff', 'chatgpt', 'claude', 'codex', 'copilot', 'opencode', 'antigravity']);

/** Extra process names that belong to a tool. */
const BINARY_ALIASES = new Map([['copilot-runtime', 'copilot']]);

/** Desktop app bundle names, e.g. "Antigravity IDE.app". */
const APP_NAMES = [
  [/^chatgpt$/i, 'chatgpt'],
  [/^freebuff$/i, 'freebuff'],
  [/antigravity/i, 'antigravity'],
  [/copilot/i, 'copilot'],
  [/codex/i, 'codex'],
  [/^claude$/i, 'claude'],
];

const INTERPRETERS = new Set(['node', 'bun', 'deno']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'tcsh', 'csh']);
const OUR_SCRIPTS = /(^|\/)(agentbus|daemon)\.js$/i;

/**
 * Renderers, GPU/utility helpers and framework processes live inside
 * `Contents/Frameworks` or are named `*Helper*`; there are dozens per app and
 * none of them is an agent.
 */
const NOT_AN_AGENT = /helper|crashpad|contents\/frameworks/i;

let cache = { at: 0, value: [] };

const baseName = (p) => String(p || '').split('/').pop().toLowerCase();

/**
 * Identify the agent a program belongs to.
 *
 * `comm` is the executable path with no arguments, so an agent's prompt text
 * can never decide which agent it is (and paths with spaces stay intact).
 * A desktop app is only itself at `<Name>.app/Contents/MacOS/<binary>`.
 */
export function identifyAgent(comm, script = null) {
  const binary = String(comm || '');
  const base = baseName(binary);
  if (!base || SHELLS.has(base)) return null;
  if (NOT_AN_AGENT.test(binary)) return null;

  const bundle = binary.match(/\/([^/]+)\.app\/Contents\/MacOS\/[^/]+$/);
  if (bundle) {
    for (const [pattern, tool] of APP_NAMES) {
      if (pattern.test(bundle[1])) return tool;
    }
    return null;
  }

  if (INTERPRETERS.has(base)) {
    // A CLI shipped as a script (`node /usr/local/bin/claude`).
    const target = baseName(script);
    if (!target || OUR_SCRIPTS.test(target)) return null;
    if (BINARY_ALIASES.has(target)) return BINARY_ALIASES.get(target);
    return TOOLS.has(target) ? target : null;
  }

  if (BINARY_ALIASES.has(base)) return BINARY_ALIASES.get(base);
  return TOOLS.has(base) ? base : null;
}

/** The script an interpreter was pointed at, taken from before any flags. */
function scriptFromCommand(command) {
  const tokens = String(command || '').trim().split(/\s+/);
  const head = [];
  for (const token of tokens) {
    if (token.startsWith('-')) break;
    head.push(token);
  }
  return head.length >= 2 ? head[head.length - 1] : null;
}

/** Working directories that never identify a project. */
function usableCwd(cwd) {
  if (!cwd || cwd === '/' || cwd === os.homedir()) return false;
  const home = os.homedir();
  for (const prefix of ['/Applications/', '/System/', '/Library/', `${home}/.`]) {
    if (cwd.startsWith(prefix)) return false;
  }
  return true;
}

function projectFromCwd(cwd) {
  if (!usableCwd(cwd)) return null;
  const project = detectProject(cwd);
  if (!project || project.root === '/' || project.root === os.homedir()) return null;
  return project;
}

/**
 * A desktop app's own cwd is `/`, but the work it is doing happens in child
 * processes: an IDE's extension host, a dev server, an agent's shell. Those
 * sit in the folder the app has open, so that is the project it is working in.
 * Require two agreeing children before believing it.
 */
const rootCache = new Map();

/** Cheap `git rev-parse` — one call per directory instead of a full detect. */
function gitRootFor(cwd) {
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  const out = run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  const root = out.status === 0 ? String(out.stdout || '').trim() : '';
  const value = root || null;
  rootCache.set(cwd, value);
  return value;
}

function inferProjectFromChildren(pids, cwds) {
  const counts = new Map();
  for (const pid of pids) {
    const cwd = cwds.get(pid);
    if (!usableCwd(cwd)) continue;
    const root = gitRootFor(cwd);
    if (!root || root === '/' || root === os.homedir()) continue;
    counts.set(root, (counts.get(root) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 2) return null;
  return projectFromCwd(best[0]);
}

function descendants(kids, root, { maxDepth = 2, cap = 40 } = {}) {
  const out = [];
  const seen = new Set([root]);
  const queue = [[root, 0]];
  while (queue.length && out.length < cap) {
    const [pid, depth] = queue.shift();
    if (depth >= maxDepth) continue;
    for (const child of kids.get(pid) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push([child, depth + 1]);
    }
  }
  return out;
}

/**
 * Agents running on this machine right now, with the project each one works in.
 *
 * The project comes from the process's own working directory, or — for a
 * desktop app sitting in `/` — from the directories its children work in.
 */
export function scanRunningAgents({ ttlMs = 4000 } = {}) {
  if (Date.now() - cache.at < ttlMs) return cache.value;

  let found = [];
  try {
    const { rows, kids } = readProcesses();
    const candidates = [];

    for (const row of rows) {
      if (row.pid === process.pid) continue;
      const base = baseName(row.comm);
      if (!base || SHELLS.has(base)) continue;
      if (NOT_AN_AGENT.test(row.comm)) continue;

      const isApp = /\.app\/Contents\/MacOS\//i.test(row.comm);
      if (INTERPRETERS.has(base)) {
        // App-internal runtimes (`…/Resources/cua_node/bin/node`) are part of a
        // desktop app, not agents; skipping them keeps the command-line pass small.
        if (/\/Contents\//i.test(row.comm)) continue;
        // Only pay for the command line when the executable is an interpreter.
        const tool = identifyAgent(row.comm, scriptFromCommand(row.command));
        if (tool) candidates.push({ pid: row.pid, tool, isApp });
        continue;
      }

      const tool = identifyAgent(row.comm);
      if (tool) candidates.push({ pid: row.pid, tool, isApp });
    }

    const cwds = resolveCwds(candidates.map((c) => c.pid));
    const trees = new Map();
    const extra = new Set();

    for (const candidate of candidates) {
      if (projectFromCwd(cwds.get(candidate.pid))) continue;
      const tree = descendants(kids, candidate.pid, 40);
      trees.set(candidate.pid, tree);
      for (const pid of tree) if (!cwds.has(pid)) extra.add(pid);
    }

    if (extra.size) {
      for (const [pid, cwd] of resolveCwds([...extra])) cwds.set(pid, cwd);
    }

    // ChatGPT and its nested Codex live in one process tree: infer once.
    const roots = [...trees.keys()];
    const inferred = new Map();
    for (const root of roots) {
      const parent = roots.find((other) => other !== root && trees.get(other).includes(root));
      if (parent != null) continue;
      const project = inferProjectFromChildren(trees.get(root), cwds);
      inferred.set(root, project);
      for (const pid of trees.get(root)) if (!inferred.has(pid)) inferred.set(pid, project);
    }

    /**
     * One entry per process for a CLI (`two windows` are two agents), but one
     * entry per tool for a desktop app, which runs many processes of itself.
     */
    const seen = new Set();
    for (const candidate of candidates) {
      const cwd = cwds.get(candidate.pid) || null;
      const project = projectFromCwd(cwd) || inferred.get(candidate.pid) || null;
      const key = candidate.isApp ? `app:${candidate.tool}` : `pid:${candidate.pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ pid: candidate.pid, tool: candidate.tool, cwd, project });
    }
  } catch {
    found = [];
  }

  cache = { at: Date.now(), value: found };
  return found;
}

function run(cmd, args) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 6000,
    windowsHide: true,
  });
}

function readProcesses() {
  const rows = [];
  const kids = new Map();
  const ps = run('ps', ['-eo', 'pid=,ppid=,comm=']);

  for (const line of String(ps.stdout || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    rows.push({ pid, ppid, comm: match[3].trim(), command: '' });
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }

  const interpreters = rows.filter((row) => INTERPRETERS.has(baseName(row.comm)));
  if (interpreters.length) {
    const out = run('ps', ['-o', 'pid=,command=', '-p', interpreters.map((r) => r.pid).join(',')]);
    const commands = new Map();
    for (const line of String(out.stdout || '').split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (match) commands.set(Number(match[1]), match[2]);
    }
    for (const row of interpreters) row.command = commands.get(row.pid) || '';
  }

  return { rows, kids };
}

function resolveCwds(pids) {
  const map = new Map();
  if (!pids.length) return map;

  // lsof exits non-zero when it cannot inspect some pids but still prints the
  // rest, so read stdout whatever the status.
  const out = run('lsof', ['-a', '-d', 'cwd', '-P', '-F', 'pn', '-p', pids.join(',')]);
  let pid = null;
  for (const line of String(out.stdout || '').split('\n')) {
    if (!line) continue;
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) map.set(pid, line.slice(1));
  }

  for (const pid of pids) {
    if (map.has(pid)) continue;
    try {
      map.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`));
    } catch {
      /* not Linux, or the process exited */
    }
  }
  return map;
}
