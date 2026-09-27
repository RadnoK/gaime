// Static gateway publication (release mode). The gateway (nginx) serves `/`, `/assets/*`
// and `/health` from this directory, so pages keep loading while the game restarts.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

function atomicFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temp = join(dirname(path), `.publish-${randomUUID()}.tmp`);
  try {
    // nginx runs under a different UID than the game.
    writeFileSync(temp, contents, { mode: 0o644 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

function files(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`The frontend must not contain symlinks: ${path}`);
    if (entry.isDirectory()) return files(root, path);
    return entry.isFile() ? [{ path, name: relative(root, path) }] : [];
  });
}

/** Validate a build and copy its assets next to older ones, while the old game still serves. */
export function preparePublic(clientDir, publicDir) {
  const index = readFileSync(join(clientDir, 'index.html'));
  const html = index.toString('utf8');
  if (!/<html[\s>]/i.test(html)) throw new Error(`No valid index.html in ${clientDir}`);
  for (const match of html.matchAll(/<(?:script|link|img|source)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const url = match[1];
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url)) continue;
    const path = resolve(clientDir, decodeURIComponent(url.split(/[?#]/)[0]).replace(/^\/+/, ''));
    if (!path.startsWith(`${clientDir}${sep}`) || !existsSync(path) || !lstatSync(path).isFile()) throw new Error(`The build references a missing file: ${url}`);
  }
  const list = files(clientDir).filter(file => file.name !== 'index.html' && file.name !== 'health.json');
  // Hashed assets must never change under a URL that old tabs or a CDN may still use.
  for (const file of list) {
    const target = join(publicDir, file.name);
    if (file.name.startsWith(`assets${sep}`) && existsSync(target) && !readFileSync(target).equals(readFileSync(file.path))) throw new Error(`Immutable asset changed under the same name: ${file.name}`);
  }
  for (const file of list) {
    const target = join(publicDir, file.name);
    const contents = readFileSync(file.path);
    if (!existsSync(target) || !readFileSync(target).equals(contents)) atomicFile(target, contents);
  }
  return index;
}

/** 200 + `{ok:false, deploying:true}`: clients wait instead of reloading into a gap. */
export function markDeploying(publicDir, version = null) {
  atomicFile(join(publicDir, 'health.json'), JSON.stringify({ ok: false, deploying: true, version }));
}

/** Only after the matching backend is healthy. Old assets are never removed. */
export function publish(clientDir, publicDir, version, game) {
  const index = preparePublic(clientDir, publicDir);
  atomicFile(join(publicDir, 'index.html'), index);
  atomicFile(join(publicDir, 'health.json'), JSON.stringify({ ok: true, version, game }));
}

/** Live mode serves everything from Vite: make sure no stale release shadows it. */
export function clearPublic(publicDir) {
  for (const name of ['index.html', 'health.json']) rmSync(join(publicDir, name), { force: true });
}
