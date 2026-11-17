import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'setup.py',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'CMakeLists.txt',
  'Makefile',
];

const cache = new Map();

function git(cwd, args) {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
      windowsHide: true,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** host/org/repo, lowercased, so clones and worktrees of one repo share a key. */
export function normalizeRemote(url) {
  if (!url) return null;
  const clean = String(url)
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .replace(/^git\+/, '')
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:/g, '/');
  return clean ? clean.toLowerCase() : null;
}

/**
 * Identify the project that owns `cwd`.
 *
 * `id` is derived from the project root, so two shells in different
 * subdirectories of the same checkout agree on it. `repoKey` identifies the
 * underlying repository, which lets the bus say "same repo, different
 * worktree" for sibling checkouts.
 */
export function detectProject(cwd = process.cwd()) {
  const start = path.resolve(String(cwd || process.cwd()));
  if (cache.has(start)) return cache.get(start);

  let real = start;
  try {
    real = fs.realpathSync(start);
  } catch {
    /* keep the resolved path */
  }

  const top = git(real, ['rev-parse', '--show-toplevel']);
  let root = top;
  let kind = 'git';

  if (!root) {
    kind = 'directory';
    let dir = real;
    while (true) {
      if (MANIFESTS.some((name) => fs.existsSync(path.join(dir, name)))) {
        root = dir;
        kind = 'manifest';
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        root = real;
        break;
      }
      dir = parent;
    }
  }

  const project = {
    id: crypto.createHash('sha1').update(root).digest('hex').slice(0, 12),
    name: path.basename(root) || root,
    root,
    kind,
  };

  if (kind === 'git') {
    const commonDir = git(real, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    project.branch = git(real, ['rev-parse', '--abbrev-ref', 'HEAD']);
    project.commit = git(real, ['rev-parse', '--short', 'HEAD']);
    project.remote = git(real, ['config', '--get', 'remote.origin.url']);
    project.repoKey = normalizeRemote(project.remote) || root;
    project.worktree = Boolean(commonDir && path.resolve(commonDir) !== path.join(root, '.git'));
  } else {
    project.repoKey = root;
  }

  cache.set(start, project);
  return project;
}

/** Short human label, e.g. "myrepo (git · main)". */
export function projectSummary(project) {
  const bits = [project.kind];
  if (project.branch) bits.push(project.branch);
  if (project.worktree) bits.push('worktree');
  return `${project.name} (${bits.join(' · ')})`;
}
