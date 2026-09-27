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

export function newGame({ root, name, title, from = 'starter' }) {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error('Game name: lowercase letters, digits and dashes, e.g. "super-popes".');
  const source = join(root, 'games', from);
  const target = join(root, 'games', name);
  if (!existsSync(source)) throw new Error(`No template games/${from}.`);
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
    if (oldTitle && /\.(html|ts)$/.test(file)) text = text.replaceAll(`>${oldTitle}<`, `>${display}<`);
    if (text !== before) writeFileSync(file, text);
  }
  return { path: relative(root, target), title: display };
}
