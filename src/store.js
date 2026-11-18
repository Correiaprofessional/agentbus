import crypto from 'node:crypto';

const MAX_TEXT = 8000;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** A message stays on the board this long, then moves to the archive. */
export const LIVE_MS = 24 * 60 * 60 * 1000;
/** How long the archive keeps it before it is deleted. */
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The person at the board page. No session stands behind their words, so every
 * reader recognises the sender by the same mark.
 */
export const USER_TOOL = 'user';

/** Was this message written by the user on the board page? Older ones said "you". */
export const isUserMessage = (message) =>
  message?.from?.tool === USER_TOOL || message?.from?.tool === 'you';

export class BusError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/**
 * In-memory presence + mailbox state for the bus.
 *
 * Sessions belong to a project (derived from their cwd). Messages are
 * project-scoped by default, so two agents in one repo talk to each other
 * without leaking into agents working in a different repo.
 */
export class Bus {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxMessages = 2000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxMessages = maxMessages;
    this.sessions = new Map();
    this.messages = [];
    this.seq = 0;
    this.waiters = new Set();
    this.startedAt = Date.now();
  }

  now() {
    return Date.now();
  }

  /* ---------------------------------------------------------------- sessions */

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.lastSeen < cutoff) this.sessions.delete(id);
    }
  }

  activeSessions() {
    this.prune();
    return [...this.sessions.values()];
  }

  getSession(id) {
    this.prune();
    return this.sessions.get(String(id || '')) || null;
  }

  /** Idempotent join: the same `key` always maps to the same session id. */
  upsertSession(input) {
    this.prune();
    const now = this.now();
    const key = input.key || null;
    const existing = key ? [...this.sessions.values()].find((s) => s.key === key) : null;

    if (existing) {
      existing.lastSeen = now;
      if (input.cwd) existing.cwd = input.cwd;
      if (input.pid != null) existing.pid = input.pid;
      if (input.name) existing.name = input.name;
      if (input.role != null) existing.role = input.role;
      if (input.status) existing.status = input.status;
      if (input.note != null) existing.note = input.note;
      if (input.project) existing.project = input.project;
      return existing;
    }

    const id = crypto.randomBytes(5).toString('hex');
    const session = {
      id,
      key,
      name: input.name || `${input.tool || 'agent'}-${id.slice(0, 4)}`,
      tool: input.tool || 'agent',
      role: input.role || null,
      host: input.host || null,
      cwd: input.cwd || null,
      pid: input.pid ?? null,
      status: input.status || 'working',
      note: input.note || null,
      project: input.project,
      joinedAt: now,
      lastSeen: now,
      cursor: this.seq, // only messages posted after joining
      received: 0,
    };
    this.sessions.set(id, session);
    return session;
  }

  touch(id, patch = {}) {
    const session = this.getSession(id);
    if (!session) return null;
    session.lastSeen = this.now();
    if (patch.status) session.status = patch.status;
    if (patch.note != null) session.note = patch.note;
    return session;
  }

  leave(id) {
    const session = this.getSession(id);
    if (!session) return null;
    this.sessions.delete(session.id);
    return session;
  }

  toPublic(session, viewer = null) {
    if (!session) return null;
    return {
      id: session.id,
      name: session.name,
      tool: session.tool,
      role: session.role,
      status: session.status,
      note: session.note,
      host: session.host,
      cwd: session.cwd,
      pid: session.pid,
      projectId: session.project.id,
      projectName: session.project.name,
      branch: session.project.branch || null,
      worktree: Boolean(session.project.worktree),
      isSelf: Boolean(viewer && viewer.id === session.id),
      joinedAt: new Date(session.joinedAt).toISOString(),
      lastSeenAt: new Date(session.lastSeen).toISOString(),
      idleMs: this.now() - session.lastSeen,
      received: session.received,
    };
  }

  /* ---------------------------------------------------------------- messages */

  resolveTarget(target, sender) {
    if (!target || !target.kind || target.kind === 'broadcast') {
      return { kind: 'broadcast', value: sender.project.id, label: 'all' };
    }

    if (target.kind === 'tool') {
      const tool = String(target.value || '').trim();
      if (!tool) throw new BusError(400, 'target tool is empty');
      return { kind: 'tool', value: tool, label: `tool:${tool}` };
    }

    if (target.kind === 'session') {
      const raw = String(target.value || '').trim();
      if (!raw) throw new BusError(400, 'target session is empty');

      let peer = this.sessions.get(raw);
      if (!peer) {
        const named = this.activeSessions().filter(
          (s) => s.name === raw && s.id !== sender.id,
        );
        const inProject = named.filter((s) => s.project.id === sender.project.id);
        const pool = inProject.length ? inProject : named;
        if (pool.length === 1) {
          peer = pool[0];
        } else if (pool.length > 1) {
          throw new BusError(409, `"${raw}" matches ${pool.length} sessions — use an id`, {
            candidates: pool.map((s) => ({
              id: s.id,
              name: s.name,
              tool: s.tool,
              project: s.project.name,
            })),
          });
        } else {
          throw new BusError(404, `no agent named "${raw}" — run \`agentbus peers\``);
        }
      }
      return { kind: 'session', value: peer.id, label: `${peer.name}(${peer.id.slice(0, 4)})` };
    }

    throw new BusError(400, `unknown target kind "${target.kind}"`);
  }

  post({ from, target, kind, text, replyTo }) {
    const sender = this.getSession(from);
    if (!sender) throw new BusError(404, 'unknown session — re-run `agentbus join`');

    const body = String(text ?? '').trim();
    if (!body) throw new BusError(400, 'message text is empty');
    if (body.length > MAX_TEXT) throw new BusError(413, `message is longer than ${MAX_TEXT} characters`);

    const to = this.resolveTarget(target, sender);
    const message = {
      id: crypto.randomBytes(5).toString('hex'),
      seq: (this.seq += 1),
      time: new Date().toISOString(),
      project: { id: sender.project.id, name: sender.project.name, root: sender.project.root },
      from: { session: sender.id, name: sender.name, tool: sender.tool, role: sender.role },
      to,
      kind: kind ? String(kind) : 'chat',
      text: body,
      replyTo: replyTo ? String(replyTo) : null,
    };

    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }

    sender.lastSeen = this.now();
    const delivered = this.activeSessions().filter((s) => this.delivers(message, s)).length;
    this.wake();
    return { message, delivered };
  }

  /**
   * You talking to a project.
   *
   * No session stands behind these words, so the message is authored by "User"
   * and then travels exactly like an agent's: it reaches everyone in the project
   * through the same inbox, log, search and retention. Writing again appends
   * rather than replaces, because the user keeps talking.
   */
  say(project, text) {
    const body = String(text ?? '').trim();
    if (!body) throw new BusError(400, 'message text is empty');
    if (body.length > MAX_TEXT) throw new BusError(413, `message is longer than ${MAX_TEXT} characters`);

    const message = {
      id: crypto.randomBytes(5).toString('hex'),
      seq: (this.seq += 1),
      time: new Date().toISOString(),
      project: { id: project.id, name: project.name || project.id, root: project.root || null },
      from: { session: null, name: 'User', tool: USER_TOOL, role: 'user' },
      to: { kind: 'broadcast', value: project.id, label: 'all' },
      kind: 'user',
      text: body,
      replyTo: null,
    };

    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }

    const delivered = this.activeSessions().filter((s) => this.delivers(message, s)).length;
    this.wake();
    return { message, delivered };
  }

  /** Would `session` receive this message? */
  delivers(message, session) {
    if (message.from.session === session.id) return false;
    if (message.to.kind === 'session') return message.to.value === session.id;
    if (message.to.kind === 'tool') {
      return message.project.id === session.project.id && message.to.value === session.tool;
    }
    return message.project.id === session.project.id;
  }

  pending(session, fromSeq) {
    const now = this.now();
    return this.messages.filter((m) => m.seq > fromSeq && this.live(m, now) && this.delivers(m, session));
  }

  /** Still on the board: younger than a day. */
  live(message, now = this.now()) {
    return now - new Date(message.time).getTime() < LIVE_MS;
  }

  /** Take the messages past their day off the board; the daemon archives them. */
  retire({ now = this.now() } = {}) {
    const kept = [];
    const stale = [];
    for (const message of this.messages) (this.live(message, now) ? kept : stale).push(message);
    this.messages = kept;
    return stale;
  }

  /** Text search over what the board is still holding, newest first. */
  search({ projectId, query, limit = 20 } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];
    const now = this.now();
    return this.messages
      .filter((m) => this.live(m, now))
      .filter((m) => !projectId || m.project.id === projectId)
      .filter((m) => `${m.text}\n${m.from.name}\n${m.kind}`.toLowerCase().includes(needle))
      .slice(-Math.max(1, Math.min(100, limit)))
      .reverse();
  }

  /**
   * Read and consume the session's mailbox, optionally long-polling until a
   * message arrives or the wait expires.
   */
  inbox(sessionId, { after, waitMs = 0 } = {}) {
    const session = this.getSession(sessionId);
    if (!session) return null;

    session.lastSeen = this.now();
    const from = Number.isFinite(after) ? after : session.cursor;
    const ready = this.pending(session, from);
    if (ready.length) return this.drain(session, ready);
    if (!waitMs) return { messages: [], cursor: session.cursor, waitedMs: 0 };

    const startedAt = this.now();
    return new Promise((resolve) => {
      const waiter = {
        sessionId,
        from,
        done: false,
        timer: null,
        finish: (messages) => {
          if (waiter.done) return;
          waiter.done = true;
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          const live = this.sessions.get(sessionId);
          if (live) {
            live.lastSeen = this.now();
            if (messages.length) live.cursor = Math.max(live.cursor, messages[messages.length - 1].seq);
          }
          resolve({
            messages,
            cursor: live ? live.cursor : from,
            waitedMs: this.now() - startedAt,
          });
        },
      };
      waiter.timer = setTimeout(() => waiter.finish([]), waitMs);
      this.waiters.add(waiter);
    });
  }

  /**
   * The session's unread messages without consuming them.
   *
   * A second reader on one session (a Copilot hook reading while the MCP
   * server holds the socket) needs to see what the socket already took, so it
   * asks from its own cursor and leaves the session's cursor alone.
   */
  peek(sessionId, { after } = {}) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.lastSeen = this.now();
    const from = Number.isFinite(after) ? after : session.cursor;
    return { messages: this.pending(session, from), cursor: session.cursor, waitedMs: 0 };
  }

  drain(session, messages) {
    session.cursor = Math.max(session.cursor, messages[messages.length - 1].seq);
    session.received += messages.length;
    return { messages, cursor: session.cursor, waitedMs: 0 };
  }

  wake() {
    if (!this.waiters.size) return;
    for (const waiter of [...this.waiters]) {
      const session = this.sessions.get(waiter.sessionId);
      if (!session) {
        waiter.finish([]);
        continue;
      }
      const messages = this.pending(session, waiter.from);
      if (messages.length) waiter.finish(messages);
    }
  }

  /* --------------------------------------------------------------- snapshots */

  overview(sessionId) {
    const sessions = this.activeSessions();
    const me = sessionId ? sessions.find((s) => s.id === sessionId) || null : null;

    const byProject = new Map();
    for (const session of sessions) {
      const id = session.project.id;
      if (!byProject.has(id)) byProject.set(id, { project: session.project, sessions: [] });
      byProject.get(id).sessions.push(this.toPublic(session, me));
    }

    let peers = [];
    const otherProjects = [];
    for (const entry of byProject.values()) {
      if (me && entry.project.id === me.project.id) {
        peers = entry.sessions.filter((s) => !s.isSelf);
        continue;
      }
      otherProjects.push({
        project: entry.project,
        sessions: entry.sessions,
        sameRepo: Boolean(me && entry.project.repoKey && entry.project.repoKey === me.project.repoKey),
      });
    }

    return {
      me: this.toPublic(me, me),
      project: me ? me.project : null,
      peers,
      otherProjects,
      totalActive: sessions.length,
    };
  }

  log(projectId, limit = 30) {
    const filtered = projectId ? this.messages.filter((m) => m.project.id === projectId) : this.messages;
    return filtered.slice(-Math.max(1, Math.min(500, limit)));
  }
}
