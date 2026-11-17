import { execFileSync } from 'node:child_process';

/** Agents the bus knows by name. Any other label still works. */
export const KNOWN_TOOLS = ['freebuff', 'claude', 'codex', 'copilot', 'opencode', 'antigravity'];

const MATCHERS = [
  ['freebuff', /freebuff/i],
  ['antigravity', /antigravity/i],
  ['opencode', /opencode/i],
  ['copilot', /copilot/i],
  ['codex', /\bcodex\b|openai[-_ ]?codex|codex-cli/i],
  ['claude', /\bclaude\b|claude-code|@anthropic-ai/i],
];

function psLine(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      windowsHide: true,
    }).trim();
    if (!out) return null;
    const match = out.match(/^(\d+)\s+([\s\S]*)$/);
    return match ? { ppid: Number(match[1]), command: match[2] } : null;
  } catch {
    return null; // no ps (Windows), or the pid is already gone
  }
}

/**
 * Find the agent process that owns this call.
 *
 * The useful part is `pid`: every shell an agent spawns shares the same agent
 * ancestor, so repeated CLI calls from one agent resolve to one bus session
 * while a second window of the same tool gets its own.
 *
 * `AGENTBUS_TOOL` wins over detection (useful on Windows, or when a wrapper
 * hides the process name).
 */
export function detectAncestorTool(startPid = process.ppid) {
  const detected = walkAncestors(startPid);
  const override = process.env.AGENTBUS_TOOL;
  if (override) {
    // Keep the detected agent pid when we found one: it keeps every shell of
    // that agent on a single session. Otherwise fall back to a cwd-based key.
    return { tool: override, pid: detected.pid, via: 'env' };
  }
  return detected;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'tcsh', 'csh']);
const INTERPRETERS = new Set(['node', 'bun', 'deno']);
const OUR_SCRIPTS = /(^|\/)(agentbus|daemon)\.js$/i;

/**
 * The program a process is, without its arguments.
 *
 * Arguments are prompt text: an agent told to "use agentbus in
 * .../freebuff-desktop/..." would otherwise look like Freebuff itself.
 */
function programOf(command) {
  const argv = command.trim().split(/\s+/);
  const first = argv[0] || '';
  const base = first.split('/').pop().toLowerCase();
  if (INTERPRETERS.has(base) && argv[1]) return `${first} ${argv[1]}`;
  return first;
}

/** Our own CLI/daemon, however it was launched. */
function isOurOwnProcess(program) {
  const parts = program.split(/\s+/);
  const script = parts.length > 1 ? parts[1] : parts[0];
  return OUR_SCRIPTS.test(script);
}

/**
 * A shell that is only running agentbus (`bash -c 'agentbus peers'`), i.e. our
 * own invocation wrapper rather than the agent that spawned it.
 *
 * Deliberately narrow: an agent's command line also mentions agentbus whenever
 * you prompt it to use the bus (`copilot -p 'run agentbus peers'`), and that
 * must still be recognised as the agent.
 */
function isOurWrapperShell(command) {
  const first = command.trim().split(/\s+/)[0] || '';
  const base = first.slice(first.lastIndexOf('/') + 1);
  return SHELLS.has(base) && /agentbus|daemon\.js/i.test(command);
}

function walkAncestors(startPid) {
  let pid = startPid;
  let guard = 0;
  while (pid && pid > 1 && guard < 12) {
    guard += 1;
    const line = psLine(pid);
    if (!line) break;
    const command = line.command;
    const program = programOf(command);
    if (!isOurOwnProcess(program) && !isOurWrapperShell(command)) {
      for (const [tool, pattern] of MATCHERS) {
        if (pattern.test(program)) return { tool, pid, via: 'process' };
      }
    }
    pid = line.ppid;
  }
  return { tool: null, pid: null, via: 'none' };
}
