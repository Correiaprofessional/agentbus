import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive } from './archive.js';
import { Bus, BusError } from './store.js';
import { detectProject } from './project.js';
import { scanRunningAgents } from './procs.js';
import { handleUpgrade } from './ws.js';
import * as paths from './paths.js';

const VERSION = '0.1.0';
const MAX_BODY = 256 * 1024;
const MAX_WAIT_MS = 120_000;
const UI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.html');

let uiCache = null;
function uiHtml() {
  if (uiCache == null) uiCache = fs.readFileSync(UI_PATH, 'utf8');
  return uiCache;
}

function note(message) {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new BusError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BusError(400, 'invalid JSON body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BusError(400, 'expected a JSON object');
  }
  return parsed;
}

/**
 * Add agents that are running but have not called `agentbus` yet, so the board
 * reflects live agents rather than only the ones that have spoken.
 */
function withRunningAgents(overview) {
  let running = [];
  try {
    running = scanRunningAgents();
  } catch {
    running = [];
  }

  const knownPids = new Set();
  if (overview.me?.pid) knownPids.add(overview.me.pid);
  for (const entry of overview.otherProjects) {
    for (const session of entry.sessions) if (session.pid) knownPids.add(session.pid);
  }

  const entries = new Map(overview.otherProjects.map((entry) => [entry.project.id, entry]));
  if (overview.project) {
    entries.set(overview.project.id, {
      project: overview.project,
      sessions: [overview.me, ...overview.peers].filter(Boolean),
      sameRepo: false,
    });
  }

  overview.running = [];
  overview.apps = [];
  for (const proc of running) {
    if (knownPids.has(proc.pid)) continue; // already listed as a session
    if (!proc.project) {
      // Desktop apps have no checkout of their own; list them separately.
      overview.apps.push({ pid: proc.pid, tool: proc.tool });
      continue;
    }
    let entry = entries.get(proc.project.id);
    if (!entry) {
      entry = { project: proc.project, sessions: [], sameRepo: false };
      entries.set(proc.project.id, entry);
      overview.otherProjects.push(entry);
    }
    const live = { pid: proc.pid, tool: proc.tool, cwd: proc.cwd, projectId: proc.project.id, projectName: proc.project.name };
    entry.running = [...(entry.running || []), live];
    overview.running.push(live);
  }

  return overview;
}

function queryNumber(url, name) {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Start the bus on loopback and publish its descriptor.
 * Only the user can reach it: the token lives in a 0600 file.
 */
export async function runDaemon({ port = 0, host = '127.0.0.1', token } = {}) {
  const authToken = token || process.env.AGENTBUS_TOKEN || crypto.randomBytes(18).toString('hex');
  const bus = new Bus();
  const archive = new Archive();
  let shuttingDown = false;
  let sweepTimer = null;
  const sockets = new Set();

  /**
   * Retention: a day on the board, a week in the archive, then gone.
   *
   * The minute-by-minute sweep keeps the board from holding yesterday, and the
   * archive from holding last week; archiving happens here and never on a read,
   * so a read is the same speed whatever the board has seen.
   */
  function sweep() {
    try {
      const retired = bus.retire();
      if (retired.length) {
        archive.append(retired);
        note(`archived ${retired.length} message(s) older than a day`);
      }
      const dropped = archive.prune();
      if (dropped) note(`deleted ${dropped} archived message(s) older than a week`);
    } catch (error) {
      note(`retention failed: ${error.message}`);
    }
  }

  /** Push an event to subscribed sockets, optionally filtered. */
  function broadcast(event, matches) {
    for (const client of sockets) {
      if (matches && !matches(client)) continue;
      client.send(event);
    }
  }

  function sessionOf(client) {
    return client.sessionId ? bus.getSession(client.sessionId) : null;
  }

  const server = http.createServer(async (req, res) => {
    if (shuttingDown) {
      sendJson(res, 503, { error: 'agentbus daemon is shutting down' });
      return;
    }

    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { error: 'bad request url' });
      return;
    }

    const pathname = url.pathname;
    const method = req.method || 'GET';

    try {
      if (pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          port: server.address()?.port ?? null,
          version: VERSION,
          startedAt: info.startedAt,
          sessions: bus.activeSessions().length,
          sockets: sockets.size,
        });
        return;
      }

      if ((pathname === '/' || pathname === '/index.html') && method === 'GET') {
        const key = url.searchParams.get('t') || req.headers['x-agentbus-token'];
        if (key !== authToken) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('agentbus ui: open the URL printed by `agentbus ui` (it carries the token)\n');
          return;
        }
        let html;
        try {
          html = uiHtml();
        } catch (err) {
          sendJson(res, 500, { error: `cannot read ui.html: ${err.message}` });
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
          'cache-control': 'no-store',
        });
        res.end(html);
        return;
      }

      const supplied = req.headers['x-agentbus-token'];
      if (supplied !== authToken) {
        sendJson(res, 401, { error: 'missing or invalid x-agentbus-token' });
        return;
      }

      if (pathname === '/api/resolve' && method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, { project: detectProject(body.cwd || process.cwd()) });
        return;
      }

      if (pathname === '/api/sessions' && method === 'POST') {
        const body = await readBody(req);
        const cwd = String(body.cwd || process.cwd());
        const project = detectProject(cwd);
        const existed = body.key
          ? bus.activeSessions().some((s) => s.key === body.key)
          : false;
        const session = bus.upsertSession({
          key: body.key,
          tool: body.tool,
          name: body.name,
          role: body.role,
          status: body.status,
          note: body.note,
          cwd,
          pid: body.pid,
          host: body.host || os.hostname(),
          project,
        });
        if (!existed) {
          note(
            `join ${session.tool} as ${session.name}(${session.id}) in ${project.name} (${project.id})`,
          );
        }
        broadcast({ type: 'presence' }, (client) => client.mode === 'board');
        sendJson(res, 200, { session: bus.toPublic(session, session), project });
        return;
      }

      let match = pathname.match(/^\/api\/sessions\/([^/]+)\/touch$/);
      if (match && method === 'POST') {
        const body = await readBody(req);
        const session = bus.touch(decodeURIComponent(match[1]), body);
        if (!session) throw new BusError(404, 'unknown session');
        sendJson(res, 200, { session: bus.toPublic(session, session) });
        return;
      }

      match = pathname.match(/^\/api\/sessions\/([^/]+)\/leave$/);
      if (match && method === 'POST') {
        const session = bus.leave(decodeURIComponent(match[1]));
        if (!session) throw new BusError(404, 'unknown session');
        note(`leave ${session.tool} as ${session.name}(${session.id})`);
        broadcast({ type: 'presence' }, (client) => client.mode === 'board');
        for (const client of sockets) {
          if (client.sessionId === session.id) client.send({ type: 'left', session: session.id });
        }
        sendJson(res, 200, { left: session.id });
        return;
      }

      if (pathname === '/api/overview' && method === 'GET') {
        const overview = withRunningAgents(bus.overview(url.searchParams.get('session') || null));
        sendJson(res, 200, overview);
        return;
      }

      if (pathname === '/api/messages' && method === 'POST') {
        const body = await readBody(req);
        const { message, delivered } = bus.post({
          from: body.from,
          target: body.target,
          kind: body.kind,
          text: body.text,
          replyTo: body.replyTo,
        });
        note(
          `msg ${message.from.name}(${message.from.session}) -> ${message.to.label} in ${message.project.name}`,
        );
        for (const client of sockets) {
          if (client.mode === 'board') {
            client.send({ type: 'message', message });
            continue;
          }
          const session = sessionOf(client);
          if (!session || !bus.delivers(message, session)) continue;
          // A pushed message is consumed: the session cursor moves with it, so
          // an HTTP inbox never hands the same message out twice.
          session.cursor = Math.max(session.cursor, message.seq);
          client.send({ type: 'message', message });
        }
        broadcast({ type: 'presence' }, (client) => client.mode === 'board');
        sendJson(res, 200, { message, delivered });
        return;
      }

      if (pathname === '/api/inbox' && method === 'GET') {
        const sessionId = url.searchParams.get('session');
        if (!sessionId) throw new BusError(400, 'missing session');
        const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, queryNumber(url, 'wait') ?? 0));
        const after = queryNumber(url, 'after');
        // peek reads from `after` and leaves the cursor where it was, so a
        // hook can read a mailbox another process is already subscribed to.
        const peek = url.searchParams.get('peek') === '1';
        const result = peek ? bus.peek(sessionId, { after }) : await bus.inbox(sessionId, { after, waitMs });
        if (!result) throw new BusError(404, 'unknown session — re-run `agentbus join`');
        sendJson(res, 200, { ...result, ...bus.overview(sessionId) });
        return;
      }

      if (pathname === '/api/log' && method === 'GET') {
        const sessionId = url.searchParams.get('session');
        const session = sessionId ? bus.getSession(sessionId) : null;
        const projectId = url.searchParams.get('project') || session?.project.id || null;
        sendJson(res, 200, { messages: bus.log(projectId, queryNumber(url, 'limit') ?? 30) });
        return;
      }

      if (pathname === '/api/search' && method === 'GET') {
        const sessionId = url.searchParams.get('session');
        const session = sessionId ? bus.getSession(sessionId) : null;
        const projectId = url.searchParams.get('project') || session?.project?.id || null;
        if (!projectId) throw new BusError(400, 'missing session');

        const query = url.searchParams.get('q') || '';
        const limit = Math.max(1, Math.min(50, queryNumber(url, 'limit') ?? 20));
        const live = bus.search({ projectId, query, limit });
        const older = archive.search({ projectId, query, limit }).map((m) => ({ ...m, archived: true }));
        const seen = new Set(live.map((m) => m.id));
        const messages = [...live, ...older.filter((m) => !seen.has(m.id))]
          .sort((a, b) => new Date(b.time) - new Date(a.time))
          .slice(0, limit);
        sendJson(res, 200, { query, project: session?.project ?? null, messages });
        return;
      }

      if (pathname === '/api/shutdown' && method === 'POST') {
        sendJson(res, 200, { stopping: true });
        shutdown('shutdown request');
        return;
      }

      sendJson(res, 404, { error: `no route for ${method} ${pathname}` });
    } catch (err) {
      if (err instanceof BusError) {
        sendJson(res, err.status, { error: err.message, ...err.extra });
        return;
      }
      note(`error: ${err.stack || err.message}`);
      sendJson(res, 500, { error: err.message || 'internal error' });
    }
  });

  /**
   * WebSocket endpoint: an agent subscribes once and receives messages as they
   * are posted, instead of long-polling for them.
   */
  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }

    const key = url.searchParams.get('t') || req.headers['x-agentbus-token'];
    if (url.pathname !== '/ws' || key !== authToken) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const client = handleUpgrade(req, socket, head, {
      onMessage(text, ws) {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'subscribe') {
          ws.mode = msg.mode === 'board' ? 'board' : 'session';
          ws.sessionId = msg.session ? String(msg.session) : null;
          const session = sessionOf(ws);

          if (ws.mode === 'session' && !session) {
            ws.send({ type: 'error', error: 'unknown session — re-run `agentbus join`' });
            return;
          }

          ws.send({
            type: 'ready',
            mode: ws.mode,
            session: session ? bus.toPublic(session, session) : null,
            cursor: session ? session.cursor : bus.seq,
          });

          if (session) {
            const since = Number.isFinite(msg.since) ? Number(msg.since) : session.cursor;
            const backlog = bus.pending(session, since);
            for (const message of backlog) ws.send({ type: 'message', message });
            if (backlog.length) {
              session.cursor = Math.max(session.cursor, backlog[backlog.length - 1].seq);
            }
          }
          return;
        }

        if (msg.type === 'ping') ws.send({ type: 'pong' });
      },
      onClose(ws) {
        if (!sockets.delete(ws)) return;
        if (!shuttingDown) note(`ws close${ws.sessionId ? ` ${ws.sessionId}` : ''}`);
      },
    });

    if (!client) return;
    sockets.add(client);
    note(`ws open (${sockets.size} socket(s))`);
  });

  const info = { pid: process.pid, port: null, token: authToken, version: VERSION, startedAt: new Date().toISOString() };

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  info.port = server.address().port;
  paths.writeDaemonInfo(info);
  note(`agentbus daemon ${VERSION} listening on ${host}:${info.port} (state ${paths.stateDir()})`);

  sweep();
  sweepTimer = setInterval(sweep, 60_000);
  sweepTimer.unref?.();

  function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    note(`stopping: ${reason}`);
    clearInterval(sweepTimer);
    for (const client of sockets) client.close(1001);
    sockets.clear();
    paths.clearDaemonInfo(process.pid);
    server.close(() => process.exit(0));
    const t = setTimeout(() => process.exit(0), 1500);
    t.unref?.();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  return { server, info, bus };
}

function portFromArgv(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) return Number(argv[i + 1]) || 0;
    if (arg.startsWith('--port=')) return Number(arg.slice(7)) || 0;
  }
  return 0;
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runDaemon({ port: portFromArgv(process.argv.slice(2)) }).catch((err) => {
    note(`failed to start: ${err.stack || err.message}`);
    process.exit(1);
  });
}
