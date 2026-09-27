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
