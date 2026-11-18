import fs from 'node:fs';
import path from 'node:path';
import { KEEP_MS } from './store.js';
import * as paths from './paths.js';

/**
 * Board messages younger than a day live in the daemon's memory. Older ones are
 * appended here, one JSON object per line, so they can still be searched for a
 * week even across a daemon restart. After the week the line is dropped.
 */
export class Archive {
  constructor({ file = path.join(paths.stateDir(), 'archive.jsonl') } = {}) {
    this.file = file;
  }

  append(messages) {
    if (!messages.length) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lines = messages.map((message) => JSON.stringify(message)).join('\n');
    fs.appendFileSync(this.file, `${lines}\n`, { mode: 0o600 });
  }

  /** Everything archived for one project, oldest first. */
  read(projectId) {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }

    const messages = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (!projectId || message.project?.id === projectId) messages.push(message);
      } catch {
        // A torn last line from a crash is worth skipping, not failing on.
      }
    }
    return messages;
  }

  /** Case-insensitive match on text, sender and kind; newest first. */
  search({ projectId, query, limit = 20, now = Date.now() } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];
    const cutoff = now - KEEP_MS;

    return this.read(projectId)
      .filter((message) => new Date(message.time).getTime() >= cutoff)
      .filter((message) => haystack(message).includes(needle))
      .slice(-Math.max(1, Math.min(100, limit)))
      .reverse();
  }

  /** Delete everything past the week; rewrites the file only when it must. */
  prune({ now = Date.now() } = {}) {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return 0;
    }

    const cutoff = now - KEEP_MS;
    const kept = [];
    let removed = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        removed += 1; // unreadable line, nothing to keep
        continue;
      }
      if (new Date(message.time).getTime() < cutoff) {
        removed += 1;
        continue;
      }
      kept.push(line);
    }

    if (!removed) return 0;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return removed;
  }
}

export function haystack(message) {
  return `${message.text || ''}\n${message.from?.name || ''}\n${message.kind || ''}`.toLowerCase();
}
