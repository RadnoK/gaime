// `gaime new <name>`: a new game in games/<name>, copied from a template game.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP = new Set(['node_modules', 'dist', '.gaime', '.devmode.json']);

function files(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Games that can be copied, with the first line of their package description. */
export function templates(root) {
  const dir = join(root, 'games');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => existsSync(join(dir, name, 'package.json'))).map(name => {
    let description = '';
    try { description = JSON.parse(readFileSync(join(dir, name, 'package.json'), 'utf8')).description ?? ''; } catch {}
    return { name, description };
  });
}

const pascal = name => name.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function newGame({ root, name, title, from = 'blank' }) {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error('Game name: lowercase letters, digits and dashes, e.g. "super-popes".');
  const source = join(root, 'games', from);
  const target = join(root, 'games', name);
  if (!existsSync(source)) throw new Error(`No template games/${from}. Available: ${templates(root).map(t => t.name).join(', ')}`);
  if (existsSync(target)) throw new Error(`games/${name} already exists.`);
  cpSync(source, target, { recursive: true, filter: path => !SKIP.has(path.split(/[\\/]/).pop()) });
  const display = title || name.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
  const oldTitle = readFileSync(join(source, 'index.html'), 'utf8').match(/<title>(.*?)<\/title>/)?.[1];
  for (const file of files(target)) {
    if (!/\.(ts|mjs|js|json|html|md|css)$/.test(file)) continue;
    let text = readFileSync(file, 'utf8');
    const before = text;
    text = text.replaceAll(`'${from}'`, `'${name}'`).replaceAll(`"name": "${from}"`, `"name": "${name}"`).replaceAll(`games/${from}`, `games/${name}`);
    // Only visible title text (<title>, headings), never identifiers such as `hurtCrystal`.
    if (oldTitle && /\.(html|ts)$/.test(file)) text = text.replaceAll(`>${oldTitle}<`, `>${display}<`).replaceAll(`title: '${oldTitle}'`, `title: '${display.replace(/'/g, "\\'")}'`);
    // The registry type (`BlankRegistry` → `HiveRegistry`) and doc headings (`# Blank (games/hive)`).
    if (/\.ts$/.test(file)) text = text.replaceAll(`${pascal(from)}Registry`, `${pascal(name)}Registry`);
    if (oldTitle && /\.md$/.test(file)) text = text.replace(new RegExp(`^(#+ .*)\\b${escape(oldTitle)}\\b`, 'gm'), `$1${display}`);
    if (text !== before) writeFileSync(file, text);
  }
  return { path: relative(root, target), title: display };
}
