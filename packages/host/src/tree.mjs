import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, utimesSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.gaime', 'dist', '.devmode.json', '.playwright-mcp']);
// Runtime files that never come from git: Vite config bundles, editor swap files.
const skip = name => SKIP.has(name) || name.includes('.timestamp-') || name.endsWith('.gaime-sync');

/** Workspace directories of a checkout, from the root package.json `workspaces` globs (`dir/*` only). */
export function workspaces(root) {
  let globs = [];
  try { globs = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? []; } catch {}
  const dirs = [];
  for (const glob of Array.isArray(globs) ? globs : globs.packages ?? []) {
    if (glob.endsWith('/*')) {
      const parent = join(root, glob.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const name of readdirSync(parent).sort()) if (existsSync(join(parent, name, 'package.json'))) dirs.push(join(glob.slice(0, -2), name));
    } else if (existsSync(join(root, glob, 'package.json'))) dirs.push(glob);
  }
  return dirs;
}

/**
 * Identity of an installed dependency tree: the lockfile plus dependency-related
 * fields of every package.json. Scripts or descriptions do not force a reinstall.
 */
export function depsKey(root) {
  const hash = createHash('sha256');
  const lock = join(root, 'package-lock.json');
  hash.update(existsSync(lock) ? readFileSync(lock) : 'no-lock');
  for (const dir of ['', ...workspaces(root)]) {
    const file = join(root, dir, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    const picked = Object.fromEntries(['name', 'version', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'workspaces', 'bin', 'overrides'].map(k => [k, pkg[k]]));
    hash.update(`\n${dir}\n${JSON.stringify(picked)}`);
  }
  return hash.digest('hex').slice(0, 16);
}

function walk(root, dir = '', out = new Map()) {
  const path = join(root, dir);
  if (!existsSync(path)) return out;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const rel = dir ? join(dir, entry.name) : entry.name;
    if (entry.isDirectory()) walk(root, rel, out);
    else out.set(rel, entry.isSymbolicLink() ? 'link' : 'file');
  }
  return out;
}

function same(a, b) {
  const sa = lstatSync(a); const sb = lstatSync(b);
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) return sa.isSymbolicLink() && sb.isSymbolicLink() && readlinkSync(a) === readlinkSync(b);
  if (sa.size !== sb.size || (sa.mode & 0o111) !== (sb.mode & 0o111)) return false;
  return readFileSync(a).equals(readFileSync(b));
}

/**
 * Make `target` equal to `source` (ignoring node_modules, .git, .gaime, dist).
 * Changed files are staged first and renamed into place together, so a watcher
 * sees one short burst instead of a slow trickle of half-written files.
 */
export function syncTree(source, target) {
  const from = walk(source);
  const to = walk(target);
  const staged = [];
  for (const [rel] of from) {
    const src = join(source, rel);
    const dst = join(target, rel);
    if (to.has(rel) && same(src, dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    if (to.has(rel) && lstatSync(dst).isDirectory()) rmSync(dst, { recursive: true, force: true });
    const temp = join(dirname(dst), `.${Math.random().toString(36).slice(2)}.gaime-sync`);
    if (lstatSync(src).isSymbolicLink()) symlinkSync(readlinkSync(src), temp);
    else { copyFileSync(src, temp); chmodSync(temp, statSync(src).mode); }
    staged.push([temp, dst]);
  }
  for (const [temp, dst] of staged) renameSync(temp, dst);
  const removed = [...to.keys()].filter(rel => !from.has(rel));
  for (const rel of removed) rmSync(join(target, rel), { force: true });
  for (const rel of removed) pruneEmpty(target, dirname(rel));
  return { changed: staged.map(([, dst]) => relative(target, dst)), removed };
}

function pruneEmpty(root, dir) {
  while (dir && dir !== '.') {
    const path = join(root, dir);
    try { if (readdirSync(path).length) return; rmdirSync(path); } catch { return; }
    dir = dirname(dir);
  }
}

/**
 * Give `toRoot` the dependencies installed in `fromRoot` without copying them:
 * every package becomes a symlink to the installed one, except workspace links,
 * which are recreated relative to `toRoot` — so `@gaime/core` in a candidate
 * resolves to the candidate's own framework source, not the running one.
 */
export function linkNodeModules(fromRoot, toRoot) {
  const realFrom = realpathSync(fromRoot);
  for (const dir of ['', ...workspaces(toRoot)]) {
    const fromModules = join(fromRoot, dir, 'node_modules');
    if (!existsSync(fromModules)) continue;
    const toModules = join(toRoot, dir, 'node_modules');
    rmSync(toModules, { recursive: true, force: true });
    mkdirSync(toModules, { recursive: true });
    for (const entry of readdirSync(fromModules)) {
      const source = join(fromModules, entry);
      if (entry.startsWith('@') && lstatSync(source).isDirectory()) {
        mkdirSync(join(toModules, entry));
        for (const scoped of readdirSync(source)) linkEntry(realFrom, join(source, scoped), join(toModules, entry, scoped));
      } else linkEntry(realFrom, source, join(toModules, entry));
    }
  }
}

function linkEntry(realFrom, source, target) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    const link = readlinkSync(source);
    const resolved = resolve(realpathSync(dirname(source)), link);
    const inside = resolved.startsWith(realFrom + sep) && !relative(realFrom, resolved).split(sep).includes('node_modules');
    if (!isAbsolute(link) && inside) { symlinkSync(link, target); return; }
  }
  try { symlinkSync(realpathSync(source), target); }
  catch { /* broken link in the installed tree: skip it */ }
}

/** Mark a file as changed for file watchers. */
export function touch(path) {
  if (!existsSync(path)) return;
  const now = new Date();
  utimesSync(path, now, now);
}
