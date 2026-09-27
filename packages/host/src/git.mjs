import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { run } from './util.mjs';

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

export function hasRemote(cwd, remote) {
  try { git(cwd, 'remote', 'get-url', remote); return true; } catch { return false; }
}

/**
 * Newest commit to run: `<remote>/<branch>` after a fetch, or local HEAD when there
 * is no remote (a laptop host deploys its own commits).
 */
export async function newest(cwd, remote, branch) {
  if (!hasRemote(cwd, remote)) return { sha: git(cwd, 'rev-parse', 'HEAD'), source: 'HEAD' };
  // --no-write-fetch-head: never race a `git pull` the operator runs in the same clone.
  await run('git', ['fetch', '--quiet', '--no-write-fetch-head', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { cwd, timeout: 30_000, quiet: true });
  return { sha: git(cwd, 'rev-parse', `refs/remotes/${remote}/${branch}`), source: `${remote}/${branch}` };
}

/** Files of commit `sha` into an empty `dir` (no .git, no untracked files). */
export function extract(cwd, sha, dir) {
  mkdirSync(dir, { recursive: true });
  const archive = `${dir}.tar`;
  try {
    execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, sha], { cwd, stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
    execFileSync('tar', ['-xf', archive, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
  } finally {
    rmSync(archive, { force: true });
  }
}

export function changedFiles(cwd, from, to) {
  if (!from) return null;
  try { return git(cwd, 'diff', '--name-only', from, to).split('\n').filter(Boolean); }
  catch { return null; }
}

/** A commit matters to a game unless it only touches other games. */
export function relevant(files, gamePath) {
  if (!files) return true;
  if (!files.length) return false;
  if (!gamePath) return true;
  const prefix = `${gamePath.replace(/\/$/, '')}/`;
  return files.some(file => !file.startsWith('games/') || file.startsWith(prefix));
}
