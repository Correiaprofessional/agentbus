import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDaemon, request } from './client.js';
import * as paths from './paths.js';
import { detectProject, projectSummary } from './project.js';
import { detectAncestorTool } from './agent.js';
import { connectSocket } from './ws.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'agentbus', version: '0.1.0' };

const PROJECT_ARG = {
  type: 'string',
  description: 'Project directory. Defaults to the working directory of this MCP server.',
};

const TOOLS = [
  {
    name: 'board_join',
    description:
      'Step 1 of every session. Announce yourself on the shared board: the project you are working in, ' +
      'a handle others can address, and what you are doing. Call it again if you switch project. ' +
      'Returns the agents already working in that project so you know who to talk to.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        name: { type: 'string', description: 'Short handle others address, e.g. "backend".' },
        role: { type: 'string', description: 'What you are doing, e.g. "rewriting the auth module".' },
      },
    },
  },
  {
    name: 'board_peers',
    description:
      'Who is working right now: agents in your project (and whether they share your project) and ' +
      'agents in other projects. Read it before starting work that could collide.',
    inputSchema: { type: 'object', properties: { project: PROJECT_ARG } },
  },
  {
    name: 'board_post',
    description:
      'Post to the board: broadcast to everyone in your project (default), to one tool, or to one agent. ' +
      'Use it to divide work, claim a file, ask a question or report progress.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to tell the other agents.' },
        to: { type: 'string', description: 'Handle or session id of one agent (direct message).' },
        to_tool: { type: 'string', description: 'Address every agent of that tool in your project.' },
        kind: { type: 'string', description: 'Free tag, e.g. claim, question, progress.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'board_read',
    description:
      'Read board messages addressed to you. Messages are pushed over a live socket held by this ' +
      'server, so a wait returns the moment someone posts. Pass wait_seconds to let another agent ' +
      'answer before you carry on.',
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'number', description: '0-120, how long to wait for a message.' },
      },
    },
  },
  {
    name: 'board_search',
    description:
      'Find earlier board messages in your project by text, sender or kind. The board keeps a ' +
      'day of messages live and archives the rest for a week, so this is how you reach what was ' +
      'said yesterday. Newest match first.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for.' },
        limit: { type: 'number', description: 'How many matches. Default 10, at most 50.' },
      },
      required: ['query'],
    },
  },
];

let clientName = '';
let sessionCache = null;
let live = null;

/**
 * Open the socket the first time this agent touches the board, and keep it:
 * messages then arrive as they are posted instead of being polled for.
 *
 * The socket belongs to one daemon. A restart gives a new pid and port, and the
 * old connection stays half-open (no close event ever arrives), so the daemon it
 * was opened against is part of the identity: without that, a stale socket is
 * reused and every read waits on a connection nobody will ever write to.
 */
function startSocket(session, info = sessionCache?.info) {
  const sameDaemon = Boolean(live?.info && info && live.info.pid === info.pid && live.info.port === info.port);
  if (live && sameDaemon && live.sessionId === session.id && live.ws) return live;
  if (live?.ws) {
    try {
      live.ws.close();
    } catch {
      /* already gone */
    }
  }

  if (!info) return null;

  const state = {
    info,
    sessionId: session.id,
    open: false,
    ws: null,
    queue: [],
    waiters: new Set(),
    attempts: 0,
  };
  live = state;

  const url = `ws://127.0.0.1:${info.port}/ws?t=${encodeURIComponent(info.token)}`;

  const connect = () => {
    const socket = connectSocket(url, {
      onOpen(ws) {
        state.open = true;
        state.attempts = 0;
        ws.send(JSON.stringify({ type: 'subscribe', mode: 'session', session: state.sessionId }));
      },
      onEvent(event) {
        if (event.type === 'message' && event.message) {
          state.queue.push(event.message);
          for (const wake of [...state.waiters]) wake();
        }
        if (event.type === 'left') state.open = false;
      },
      onClose() {
        state.open = false;
        state.ws = null;
        if (state.attempts < 4) {
          state.attempts += 1;
          setTimeout(connect, 400 * state.attempts).unref?.();
        }
      },
    });
    if (socket) state.ws = socket;
  };

  connect();
  return state;
}

/** Wait for pushed messages, or return what already arrived. */
function drainLive(state, timeoutMs) {
  if (state.queue.length) return Promise.resolve(state.queue.splice(0, state.queue.length));
  if (!timeoutMs) return Promise.resolve([]);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (messages) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.waiters.delete(wake);
      resolve(messages);
    };
    const wake = () => {
      if (state.queue.length) finish(state.queue.splice(0, state.queue.length));
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    state.waiters.add(wake);
  });
}

const formatMessage = (m) =>
  `[${new Date(m.time).toTimeString().slice(0, 8)}] ${m.from.name} (${m.from.tool}) → ${m.to.label}: ${m.text}`;

function toolLabel() {
  const fromEnv = process.env.AGENTBUS_TOOL;
  if (fromEnv) return fromEnv;
  const name = clientName.toLowerCase();
  for (const tool of ['claude', 'codex', 'copilot', 'opencode', 'antigravity', 'freebuff', 'chatgpt']) {
    if (name.includes(tool)) return tool;
  }
  return detectAncestorTool().tool || 'agent';
}

/**
 * Advertise the session this server holds.
 *
 * A hook runs in its own process and never sees this server's socket queue, so
 * it needs the session id to read the same mailbox. The file is this process's
 * pid, which keeps one window's session from overwriting another's.
 */
function publishSession(session, info) {
  const dir = path.join(paths.stateDir(), 'mcp');
  const file = path.join(dir, `${process.pid}.json`);
  const entry = {
    sessionId: session.id,
    tool: session.tool,
    cwd: process.cwd(),
    daemon: { pid: info.pid, port: info.port },
    updatedAt: Date.now(),
  };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    // No file: a hook stays quiet, nothing else breaks.
  }
  if (publishSession.installed) return;
  publishSession.installed = true;
  const clean = () => {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
  process.on('exit', clean);
  process.on('SIGTERM', clean);
  process.on('SIGINT', clean);
}

async function board({ project, name, role } = {}) {
  const info = await ensureDaemon();
  const cwd = project ? String(project) : process.cwd();
  const tool = toolLabel();
  const key = `mcp:${process.ppid}:${tool}`;

  const res = await request(info, 'POST', '/api/sessions', {
    key,
    tool,
    name: name || undefined,
    role: role ?? undefined,
    status: 'working',
    cwd,
    pid: process.ppid,
    host: os.hostname(),
  });

  sessionCache = { info, session: res.session, project: res.project || res.session.project };
  publishSession(res.session, info);
  startSocket(res.session, info);
  return sessionCache;
}

/**
 * Join and open the socket as soon as the client loads this server, so an agent
 * is on the board from the start rather than after its first tool call. Folder
 * that is neither a git checkout nor a manifest is left alone: there is no
 * project to be working in.
 */
async function connectOnStart() {
  try {
    const project = detectProject(process.cwd());
    if (project.kind === 'directory') return;
    await board();
  } catch {
    // No daemon and no project: the first tool call retries.
  }
}

async function currentProject() {
  if (sessionCache) return sessionCache.project;
  return detectProject(process.cwd());
}

const fmtPeer = (p) =>
  `- ${p.name} (${p.tool}) ${p.status} · ${Math.round(p.idleMs / 1000)}s idle${p.role ? ` — ${p.role}` : ''}${
    p.branch ? ` [${p.branch}]` : ''
  }`;

async function boardJoin(args) {
  const { session, project } = await board(args);
  const { info } = sessionCache;
  const overview = await request(info, 'GET', `/api/overview?session=${session.id}`);

  const lines = [
    `You are on the board as ${session.name} (${session.tool}) in project ${projectSummary(project)}.`,
    `Project id ${project.id}${project.root !== project.id ? ` · root ${project.root}` : ''}.`,
    '',
  ];

  if (overview.peers.length) {
    lines.push(`${overview.peers.length} other agent(s) working in this project:`);
    for (const peer of overview.peers) lines.push(fmtPeer(peer));
  } else {
    lines.push('Nobody else is working in this project yet.');
  }

  const runningHere = (overview.running || []).filter((r) => r.projectId === project.id);
  if (runningHere.length) {
    lines.push('');
    lines.push('Also running here, not on the board yet (a post for them waits in the project log):');
    for (const proc of runningHere) lines.push(`- ${proc.tool} (pid ${proc.pid})`);
  }

  if (overview.otherProjects.length) {
    lines.push('');
    lines.push('Elsewhere (different project, do not assume they see your posts):');
    for (const entry of overview.otherProjects) {
      const tag = entry.sameRepo ? ', same repo different checkout' : '';
      const who = [...entry.sessions.map((s) => `${s.name} (${s.tool})`), ...(entry.running || []).map((r) => `${r.tool} running`)];
      lines.push(`- ${entry.project.name}${tag}: ${who.join(', ') || 'no agents'}`);
    }
  }

  lines.push('');
  lines.push(
    live?.open
      ? 'Live websocket is open: replies are pushed to you as they are posted. Talk with board_post; read with board_read.'
      : 'Talk with board_post; check replies with board_read {wait_seconds: 30}.',
  );
  return lines.join('\n');
}

async function boardPeers(args) {
  const { session } = await board(args);
  const { info, project } = sessionCache;
  const overview = await request(info, 'GET', `/api/overview?session=${session.id}`);

  const lines = [`Project ${projectSummary(project)} (${project.id}).`];
  lines.push(
    overview.peers.length
      ? `${overview.peers.length} other agent(s) working in this project:`
      : 'No other agent is working in this project.',
  );
  for (const peer of overview.peers) lines.push(fmtPeer(peer));

  const runningHere = (overview.running || []).filter((r) => r.projectId === project.id);
  if (runningHere.length) {
    lines.push('');
    lines.push('Running here, not on the board yet:');
    for (const proc of runningHere) lines.push(`- ${proc.tool} (pid ${proc.pid})`);
  }

  lines.push('');
  if (overview.otherProjects.length) {
    lines.push('Other projects (they do not see your posts):');
    for (const entry of overview.otherProjects) {
      const tag = entry.sameRepo ? ' (same repo, different checkout)' : '';
      const parts = [];
      if (entry.sessions.length) {
        parts.push(`${entry.sessions.map((s) => `${s.name} (${s.tool})`).join(', ')} on the board`);
      }
      if ((entry.running || []).length) {
        parts.push(`${entry.running.map((r) => r.tool).join(', ')} running, not on the board`);
      }
      lines.push(`- ${entry.project.name}${tag}: ${parts.join('; ') || 'no agents'}`);
    }
  } else {
    lines.push('No agents in other projects.');
  }
  return lines.join('\n');
}

async function boardPost(args) {
  const { session } = await board();
  const { info } = sessionCache;
  const text = String(args?.message || '').trim();
  if (!text) throw new Error('message is empty');

  const target = args.to
    ? { kind: 'session', value: String(args.to) }
    : args.to_tool
      ? { kind: 'tool', value: String(args.to_tool) }
      : { kind: 'broadcast', value: null };

  const res = await request(info, 'POST', '/api/messages', {
    from: session.id,
    text,
    kind: args.kind || 'chat',
    target,
  });

  const line = `Posted to ${res.message.to.label} (seq ${res.message.seq}); ${res.delivered} agent(s) listening now.`;
  return res.delivered
    ? line
    : `${line} Nobody is connected in this project yet, so it stays in the project log for the next agent to read.`;
}

async function boardRead(args) {
  const { session } = await board();
  const { info } = sessionCache;
  const wait = Math.max(0, Math.min(120, Number(args?.wait_seconds) || 0));
  const state = startSocket(session, info);

  // The open socket is the conversation: messages were pushed here as they were
  // posted, so a read is instant and a wait is a promise, not a poll.
  if (state && (state.open || state.queue.length)) {
    const messages = await drainLive(state, wait * 1000);
    if (!messages.length) {
      return state.open
        ? 'No new board messages. (websocket is open and will wake on the next one)'
        : 'No new board messages.';
    }
    return messages.map(formatMessage).join('\n');
  }

  const res = await request(
    info,
    'GET',
    `/api/inbox?session=${session.id}&wait=${wait * 1000}`,
    null,
    { timeoutMs: wait * 1000 + 8000 },
  );

  if (!res.messages.length) return 'No new board messages.';
  return res.messages.map(formatMessage).join('\n');
}

async function boardSearch(args) {
  const { session } = await board();
  const { info, project } = sessionCache;
  const query = String(args?.query || '').trim();
  if (!query) throw new Error('query is empty');
  const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
  const params = new URLSearchParams({ session: session.id, q: query, limit: String(limit) });
  const res = await request(info, 'GET', `/api/search?${params}`);
  const messages = res.messages || [];

  if (!messages.length) {
    return `No board message in ${projectSummary(project)} matches "${query}" (the board keeps a day, the archive a week).`;
  }
  const lines = [`${messages.length} match(es) for "${query}" in ${projectSummary(project)}:`];
  for (const message of messages) {
    lines.push(`${message.archived ? '(archive) ' : ''}${formatMessage(message)}`);
  }
  return lines.join('\n');
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'board_join':
      return boardJoin(args);
    case 'board_peers':
      return boardPeers(args);
    case 'board_post':
      return boardPost(args);
    case 'board_read':
      return boardRead(args);
    case 'board_search':
      return boardSearch(args);
    default:
      throw new Error(`unknown tool "${name}"`);
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function respond(id, error, result) {
  if (error) write({ id, error });
  else write({ id, result });
}

async function dispatch(method, params) {
  if (method === 'initialize') {
    clientName = String(params?.clientInfo?.name || '');
    void connectOnStart();
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        'Shared board for coding agents. This server is already on the board and holds a live ' +
        'socket, so messages are pushed to it as other agents post. Call board_join to say what ' +
        'you are working on, board_peers to see who else is here, board_post to divide work, and ' +
        'board_read to hear back, and board_search to find what was said yesterday: the board ' +
        'keeps a day of messages live and archives them for a week. To update agentbus itself, run `agentbus update` (it pulls the ' +
        'latest version, restarts the daemon and relaunches the menu bar app).',
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    try {
      const text = await callTool(params?.name, params?.arguments || {});
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `agentbus: ${err.message}` }], isError: true };
    }
  }
  const error = new Error(`method not found: ${method}`);
  error.code = -32601;
  throw error;
}

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    respond(null, { code: -32700, message: 'parse error' });
    return;
  }

  if (message.id === undefined) return; // notification
  if (message.method === undefined) {
    respond(message.id, { code: -32600, message: 'invalid request' });
    return;
  }

  try {
    const result = await dispatch(message.method, message.params || {});
    respond(message.id, null, result);
  } catch (err) {
    respond(message.id, { code: err.code || -32603, message: err.message || 'internal error' });
  }
}

/**
 * Pull one complete JSON object out of the stream.
 *
 * MCP frames messages with newlines, but not every client sends the newline: an
 * object written without a trailing delimiter is still a whole message, and
 * waiting for a line that never comes leaves the client hanging on `initialize`.
 * The brace walk also copes with pretty-printed objects and with several
 * messages arriving in a single chunk.
 */
export function takeMessage(text) {
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      start = i;
      break;
    }
    if (ch !== ' ' && ch !== '\n' && ch !== '\r' && ch !== '\t') return { json: null, rest: text.slice(i + 1) };
  }
  if (start === -1) return { json: null, rest: '' };

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { json: text.slice(start, i + 1), rest: text.slice(i + 1) };
    }
  }
  return { json: null, rest: text.slice(start) };
}

/** Serve the board over MCP on stdin/stdout. Nothing else may touch stdout. */
export async function runMcpServer() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const { json, rest } = takeMessage(buffer);
      buffer = rest;
      if (!json) break;
      void handleLine(json);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}
