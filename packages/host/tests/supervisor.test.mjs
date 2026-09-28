import { afterEach, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendControl, Supervisor } from '../src/supervisor.mjs';
import { readJson } from '../src/util.mjs';

const roots = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

function supervisor(mode) {
  const stateDir = mkdtempSync(join(tmpdir(), 'gaime-sup-'));
  roots.push(stateDir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return new Supervisor({ stateDir, dataDir: join(stateDir, 'data'), publicDir: join(stateDir, 'public'), mode, game: 'test', gamePath: 'games/test', port: 5999, gates: [] });
}

test('controls are acknowledged in host.json with their id and outcome', async () => {
  const s = supervisor('live');
  const paused = sendControl(s.c, 'pause');
  await s.controls();
  expect(readJson(s.p.state, {})).toMatchObject({ paused: true, control: { id: paused, command: 'pause', ok: true } });
  const failed = sendControl(s.c, 'rollback');
  await s.controls();
  expect(readJson(s.p.state, {}).control).toMatchObject({ id: failed, command: 'rollback', ok: false, error: expect.stringMatching(/no previous version/) });
});

test('a live rollback cannot be rolled back again into the bad version', async () => {
  const s = supervisor('live');
  s.save({ current: { sha: 'bad' }, previous: { sha: 'good' } });
  s.mode.deploy = async sha => { s.save({ current: { sha }, previous: { sha: 'bad' } }); return 'hot reload'; };
  sendControl(s.c, 'rollback');
  await s.controls();
  expect(readJson(s.p.state, {})).toMatchObject({ current: { sha: 'good' }, previous: null, attempted: 'bad', paused: true });
});

test('gaime status --json prints only JSON', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gaime-status-'));
  roots.push(stateDir);
  const status = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/gaime.mjs', import.meta.url)), 'status', '--json'], {
      cwd: fileURLToPath(new URL('../../../games/blank', import.meta.url)), encoding: 'utf8',
      env: { ...process.env, GAIME_STATE_DIR: stateDir, GAIME_URL: 'http://127.0.0.1:9' },
    });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  };
  expect(status()).toMatchObject({ state: null });
  writeFileSync(join(stateDir, 'host.json'), JSON.stringify({ pid: null, mode: 'live', status: 'stopped', history: [{ sha: 'abc', result: 'hot reload' }] }));
  expect(status()).toMatchObject({ mode: 'live', running: false, health: null });
});

test('several processes: release mode and Redis only; each gets its port and public address', async () => {
  const { resolveConfig, processEnv, publicAddress } = await import('../src/supervisor.mjs');
  const game = fileURLToPath(new URL('../../../games/blank', import.meta.url));
  const base = { GAIME_STATE_DIR: mkdtempSync(join(tmpdir(), 'gaime-procs-')) };
  roots.push(base.GAIME_STATE_DIR);
  expect(() => resolveConfig(game, { ...base, GAIME_PROCESSES: '3' })).toThrow(/needs GAIME_MODE=release/);
  expect(() => resolveConfig(game, { ...base, GAIME_MODE: 'release', GAIME_PROCESSES: '3' })).toThrow(/needs GAIME_REDIS_URL/);
  const c = resolveConfig(game, { ...base, GAIME_MODE: 'release', GAIME_PROCESSES: '3', GAIME_PORT: '6000', GAIME_REDIS_URL: 'redis://redis:6379', GAIME_PUBLIC_URL: 'https://game.example.com/' });
  expect(c.processes).toBe(3);
  expect(publicAddress(c, 2)).toBe('game.example.com/p2');
  expect(processEnv(c, 1)).toEqual({ GAIME_PORT: '6001', GAIME_PROCESS_INDEX: '1', GAIME_PROCESSES: '3', GAIME_PUBLIC_ADDRESS: 'game.example.com/p1', GAIME_REDIS_URL: 'redis://redis:6379' });
  expect(publicAddress({ ...c, publicUrl: '' }, 1)).toBe('127.0.0.1:6001');
  // One process (the default): nothing but the port.
  expect(processEnv(resolveConfig(game, { ...base, GAIME_PORT: '6000' }), 0)).toEqual({ GAIME_PORT: '6000' });
});

test('a crashed process is restarted alone; health waits for every process', async () => {
  const s = supervisor('release');
  s.c.processes = 2;
  const fake = (index, exitCode = null) => Object.assign({ pid: 1_000_000 + index, exitCode, signalCode: null }, { gaimeIndex: index, gaimePort: 5999 + index });
  s.children = [fake(0), fake(1, 1)];
  s.crashed(s.children[1]);
  expect(s.missing()).toEqual([1]);
  let asked;
  s.mode.startCurrent = async indexes => { asked = indexes; s.children.push(fake(1)); };
  await s.revive();
  expect(asked).toEqual([1]);
  expect(s.missing()).toEqual([]);
  s.health = async port => ({ ok: true, version: port === 5999 ? 'new' : 'old' });
  await expect(s.waitHealthy('new', 1000, 0)).rejects.toThrow(/process 1: version old/);
  s.health = async () => ({ ok: true, version: 'new' });
  await expect(s.waitHealthy('new', 1000, 0)).resolves.toBeUndefined();
});
