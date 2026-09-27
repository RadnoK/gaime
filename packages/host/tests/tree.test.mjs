import { afterEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { depsKey, linkNodeModules, syncTree } from '../src/tree.mjs';
import { relevant } from '../src/git.mjs';

const roots = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'gaime-tree-')); roots.push(dir); return dir; };
const write = (path, text) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, text); };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('syncTree', () => {
  test('copies changes, deletes removed files, leaves node_modules and state alone', () => {
    const source = temp(); const target = temp();
    write(join(source, 'src/a.ts'), 'new a');
    write(join(source, 'src/features/x/server.ts'), 'x');
    write(join(target, 'src/a.ts'), 'old a');
    write(join(target, 'src/features/gone/server.ts'), 'gone');
    write(join(target, 'node_modules/dep/index.js'), 'dep');
    write(join(target, '.gaime/data/checkpoint.json'), '{}');
    const result = syncTree(source, target);
    expect(readFileSync(join(target, 'src/a.ts'), 'utf8')).toBe('new a');
    expect(existsSync(join(target, 'src/features/x/server.ts'))).toBe(true);
    expect(existsSync(join(target, 'src/features/gone'))).toBe(false);
    expect(existsSync(join(target, 'node_modules/dep/index.js'))).toBe(true);
    expect(existsSync(join(target, '.gaime/data/checkpoint.json'))).toBe(true);
    expect(result.removed).toEqual(['src/features/gone/server.ts']);
    expect(syncTree(source, target)).toEqual({ changed: [], removed: [] });
  });
});

describe('linkNodeModules', () => {
  test('links packages to the installed tree but workspace packages to the new tree', () => {
    const from = temp(); const to = temp();
    for (const root of [from, to]) {
      write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
      write(join(root, 'packages/core/package.json'), '{"name":"@x/core"}');
    }
    write(join(from, 'node_modules/three/index.js'), 'three');
    mkdirSync(join(from, 'node_modules/@x'), { recursive: true });
    symlinkSync('../../packages/core', join(from, 'node_modules/@x/core'));
    linkNodeModules(from, to);
    expect(realpathSync(join(to, 'node_modules/three'))).toBe(realpathSync(join(from, 'node_modules/three')));
    expect(readlinkSync(join(to, 'node_modules/@x/core'))).toBe('../../packages/core');
    expect(realpathSync(join(to, 'node_modules/@x/core'))).toBe(realpathSync(join(to, 'packages/core')));
  });
});

describe('depsKey', () => {
  test('changes with dependencies, not with scripts', () => {
    const root = temp();
    write(join(root, 'package.json'), JSON.stringify({ workspaces: ['games/*'] }));
    write(join(root, 'package-lock.json'), '{}');
    write(join(root, 'games/a/package.json'), JSON.stringify({ name: 'a', scripts: { dev: 'vite' } }));
    const first = depsKey(root);
    write(join(root, 'games/a/package.json'), JSON.stringify({ name: 'a', scripts: { dev: 'vite --open' } }));
    expect(depsKey(root)).toBe(first);
    write(join(root, 'games/a/package.json'), JSON.stringify({ name: 'a', dependencies: { nanoid: '^5' } }));
    expect(depsKey(root)).not.toBe(first);
  });
});

describe('relevant', () => {
  test('a commit touching only other games does not redeploy this one', () => {
    expect(relevant(['games/other/src/a.ts'], 'games/starter')).toBe(false);
    expect(relevant(['games/starter/src/a.ts'], 'games/starter')).toBe(true);
    expect(relevant(['packages/core/src/x.ts'], 'games/starter')).toBe(true);
    expect(relevant(['package-lock.json', 'games/other/package.json'], 'games/starter')).toBe(true);
    expect(relevant(null, 'games/starter')).toBe(true);
    expect(relevant([], 'games/starter')).toBe(false);
  });
});
