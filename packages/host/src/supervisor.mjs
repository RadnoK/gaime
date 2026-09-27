// One supervisor per game: follows a git branch, deploys every new commit, keeps the
// game's checkpoint safe and rolls back what does not start.
//
// live mode    — Vite + Colyseus keep running; a commit is synced into the live tree and
//                hot-reloaded (client HMR, server room cache/restore). Restart only when
//                dependencies change. Seconds from push to players.
// release mode — every commit becomes an isolated production build; the old build keeps
//                serving until the new one is compiled, then a short restart. A static
//                gateway (nginx) keeps the page and assets online during the swap.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join, relative } from 'node:path';
import { changedFiles, extract, git, newest, relevant } from './git.mjs';
import { clearPublic, markDeploying, preparePublic, publish } from './public-release.mjs';
import { depsKey, linkNodeModules, syncTree, touch, workspaces } from './tree.mjs';
import { alive, delay, log, readJson, run, short, writeAtomic } from './util.mjs';

export function resolveConfig(cwd = process.cwd(), env = process.env) {
  const repoRoot = realpathSync(git(cwd, 'rev-parse', '--show-toplevel'));
  for (const file of [join(cwd, '.env'), join(repoRoot, '.env')]) {
    try { process.loadEnvFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const gameDir = realpathSync(cwd);
  const gamePath = relative(repoRoot, gameDir);
  let game = env.GAIME_GAME;
  if (!game) { try { game = JSON.parse(readFileSync(join(gameDir, 'package.json'), 'utf8')).name; } catch {} }
  game ||= basename(gameDir);
  const mode = env.GAIME_MODE === 'release' || env.GAIME_MODE === 'production' ? 'release' : 'live';
  const stateDir = env.GAIME_STATE_DIR || join(repoRoot, '.gaime', game);
  // Default gate: typecheck in live mode (it hot-swaps into a running game); release mode has the build.
  const gatesSetting = !env.GAIME_GATES || env.GAIME_GATES === 'auto' ? (mode === 'live' ? 'check' : '') : env.GAIME_GATES === 'none' ? '' : env.GAIME_GATES;
  const gates = gatesSetting.split(',').map(s => s.trim()).filter(Boolean);
  const port = Number(env.GAIME_PORT || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GAIME_PORT must be a port number.');
  return {
    repoRoot, gamePath, game, mode, port, gates, stateDir,
    dataDir: env.GAIME_DATA_DIR || join(stateDir, 'data'),
    publicDir: env.GAIME_PUBLIC_DIR || join(stateDir, 'public'),
    remote: env.GAIME_REMOTE || 'origin',
    branch: env.GAIME_BRANCH || 'main',
    pollMs: Number(env.GAIME_POLL_MS || 3000),
    startTimeout: Number(env.GAIME_START_TIMEOUT_MS || 120_000),
    hmrTimeout: Number(env.GAIME_HMR_TIMEOUT_MS || 30_000),
    soakMs: Number(env.GAIME_SOAK_MS || 2500),
    serverEntry: env.GAIME_SERVER_ENTRY || 'src/server/index.ts',
  };
}

export const paths = config => ({
  state: join(config.stateDir, 'host.json'),
  lock: join(config.stateDir, 'host.lock'),
  controls: join(config.stateDir, 'controls'),
  snapshots: join(config.stateDir, 'snapshots'),
  work: join(config.stateDir, 'work'),
  live: join(config.stateDir, 'live'),
  releases: join(config.stateDir, 'releases'),
  deps: join(config.stateDir, 'deps'),
  versionFile: join(config.stateDir, 'live-version'),
  applying: join(config.stateDir, 'applying'),
  checkpoint: join(config.dataDir, 'checkpoint.json'),
});

export function sendControl(config, command) {
  const p = paths(config);
  mkdirSync(p.controls, { recursive: true });
  writeAtomic(join(p.controls, `${Date.now()}-${randomUUID()}.json`), { command });
}

export class Supervisor {
  constructor(config) {
    this.c = config;
    this.p = paths(config);
    this.state = readJson(this.p.state, {});
    this.child = null;
    this.stopping = false;
    this.crashes = [];
    this.restartAt = 0;
    this.mode = config.mode === 'release' ? new ReleaseMode(this) : new LiveMode(this);
  }

  save(patch = {}) {
    Object.assign(this.state, patch);
    writeAtomic(this.p.state, { ...this.state, updatedAt: new Date().toISOString() });
  }

  record(entry) {
    const history = [{ ...entry, at: new Date().toISOString() }, ...(this.state.history ?? [])].slice(0, 30);
    this.save({ history });
  }

  async start() {
    for (const dir of [this.c.stateDir, this.c.dataDir, this.p.controls, this.p.snapshots]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.lock();
    const stop = () => { if (!this.stopping) log('Stopping…'); this.stopping = true; };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    rmSync(this.p.work, { recursive: true, force: true });
    this.save({ pid: process.pid, game: this.c.game, mode: this.c.mode, port: this.c.port, gamePath: this.c.gamePath, status: 'starting', error: null });
    log(`${this.c.game} · ${this.c.mode} mode · port ${this.c.port} · following ${this.c.remote}/${this.c.branch} every ${this.c.pollMs / 1000} s`);
    try {
      await ensureFreePort(this.c.port);
      let target = this.state.current?.sha;
      if (!this.state.paused || !target) {
        try { target = (await newest(this.c.repoRoot, this.c.remote, this.c.branch)).sha; }
        catch (error) { log(`Could not fetch ${this.c.remote}/${this.c.branch}: ${error.message}`); target ??= git(this.c.repoRoot, 'rev-parse', 'HEAD'); }
      }
      await this.mode.boot(target);
      this.save({ status: 'running' });
      await this.loop();
    } catch (error) {
      this.save({ status: 'stopped', error: error.message });
      throw error;
    } finally {
      await this.stopChild();
      this.save({ status: 'stopped', pid: null, childPid: null });
      rmSync(this.p.lock, { recursive: true, force: true });
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
    }
  }

  lock() {
    if (existsSync(this.p.lock)) {
      const owner = readJson(join(this.p.lock, 'owner.json'), {});
      // A restarted container may reuse the PID; our own PID cannot be a rival.
      if (owner.pid !== process.pid && alive(owner.pid)) throw new Error(`The supervisor is already running (PID ${owner.pid}). Use: gaime status`);
      rmSync(this.p.lock, { recursive: true, force: true });
    }
    mkdirSync(this.p.lock);
    writeAtomic(join(this.p.lock, 'owner.json'), { pid: process.pid });
  }

  async loop() {
    let nextPoll = Date.now() + this.c.pollMs;
    while (!this.stopping) {
      await this.controls();
      if (this.child && (this.child.exitCode !== null || this.child.signalCode !== null)) this.crashed();
      if (!this.child && this.state.current && Date.now() >= this.restartAt && !this.stopping) await this.revive();
      if (!this.state.paused && Date.now() >= nextPoll) {
        try {
          const { sha } = await newest(this.c.repoRoot, this.c.remote, this.c.branch);
          if (sha !== this.state.current?.sha && sha !== this.state.attempted) await this.deploy(sha);
        } catch (error) { log(`Update check: ${error.message}`); this.save({ error: error.message }); }
        nextPoll = Date.now() + this.c.pollMs;
      }
      await delay(200);
    }
  }

  async controls() {
    let files = [];
    try { files = readdirSync(this.p.controls).filter(name => name.endsWith('.json')).sort(); } catch {}
    for (const file of files) {
      const path = join(this.p.controls, file);
      const { command } = readJson(path, {});
      rmSync(path, { force: true });
      try {
        if (command === 'pause') { this.save({ paused: true }); log('Automatic updates paused.'); }
        if (command === 'resume') { this.save({ paused: false, error: null }); log('Automatic updates resumed.'); }
        if (command === 'redeploy') { this.save({ attempted: null, failed: null, paused: false }); log('Retrying the newest commit.'); }
        if (command === 'restart') { log('Restarting the game process…'); await this.stopChild(); this.restartAt = 0; }
        if (command === 'rollback') {
          this.save({ paused: true });
          await this.mode.rollback();
          this.save({ status: 'running', error: null });
          log('Rolled back to the previous version. Updates are paused — after a fix: gaime resume');
        }
      } catch (error) { log(`${command}: ${error.message}`); this.save({ error: error.message }); }
    }
  }

  async deploy(sha) {
    const previous = this.state.current?.sha;
    const files = changedFiles(this.c.repoRoot, previous, sha);
    if (previous && !relevant(files, this.c.gamePath)) {
      log(`${short(sha)} does not touch ${this.c.gamePath} or shared code — skipping.`);
      this.save({ attempted: sha });
      return;
    }
    const subject = safe(() => git(this.c.repoRoot, 'log', '-1', '--format=%an: %s', sha)) ?? '';
    log(`New commit ${short(sha)} ${subject}`);
    this.save({ attempted: sha, status: 'preparing', error: null });
    const started = Date.now();
    try {
      const result = await this.mode.deploy(sha);
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      if (result === 'superseded') { log(`${short(sha)} superseded by a newer commit.`); this.save({ attempted: null }); }
      else log(`✅ ${short(sha)} is live (${result}, ${seconds} s)`);
      this.record({ sha, subject, result, seconds });
      this.save({ status: 'running', failed: null });
    } catch (error) {
      log(`❌ ${short(sha)} failed: ${error.message}`);
      log(`The game keeps running ${short(this.state.current?.sha)}. The next commit will try again.`);
      this.record({ sha, subject, result: 'failed', error: error.message });
      this.save({ status: this.child ? 'running' : 'stopped', failed: { sha, error: error.message }, error: error.message });
    } finally {
      rmSync(this.p.work, { recursive: true, force: true });
    }
  }

  async superseded(sha) {
    try { return (await newest(this.c.repoRoot, this.c.remote, this.c.branch)).sha !== sha; }
    catch { return false; }
  }

  workDir(label) {
    const dir = join(this.p.work, `${label}-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async gates(root) {
    for (const gate of this.c.gates) {
      log(`Gate: npm run ${gate}`);
      await run('npm', ['run', gate, '--if-present'], { cwd: join(root, this.c.gamePath), timeout: 300_000 });
    }
  }

  async install(root) {
    log('Installing dependencies (npm ci)…');
    await run('npm', ['ci', '--no-audit', '--no-fund', '--include=dev'], { cwd: root, timeout: 900_000, env: { ...process.env, NODE_ENV: 'development' } });
  }

  // ── checkpoint snapshots ──────────────────────────────────────────

  snapshot(label) {
    if (!existsSync(this.p.checkpoint)) return null;
    const path = join(this.p.snapshots, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.json`);
    copyFileSync(this.p.checkpoint, path);
    const all = readdirSync(this.p.snapshots).filter(n => n.endsWith('.json')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 40))) rmSync(join(this.p.snapshots, old), { force: true });
    return path;
  }

  restoreCheckpoint(snapshot) {
    if (existsSync(this.p.checkpoint)) copyFileSync(this.p.checkpoint, join(this.p.snapshots, `${new Date().toISOString().replace(/[:.]/g, '-')}-discarded.json`));
    if (snapshot && existsSync(snapshot)) { copyFileSync(snapshot, `${this.p.checkpoint}.restore`); renameSync(`${this.p.checkpoint}.restore`, this.p.checkpoint); }
    else rmSync(this.p.checkpoint, { force: true });
  }

  // ── child process ─────────────────────────────────────────────────

  spawnChild(cwd, args, env) {
    log(`Start: npm ${args.join(' ')} (${relative(this.c.stateDir, cwd) || cwd})`);
    const child = spawn('npm', args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', error => log(`Proces gry: ${error.message}`));
    // Pass the output through, and notice a failed server hot reload right away
    // instead of waiting for the health timeout.
    for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      let tail = '';
      stream.on('data', chunk => {
        out.write(chunk);
        tail = (tail + chunk).slice(-4000);
        const match = /\[colyseus\] Failed to (?:re)?load server module:?\s*([^\n]*)/.exec(tail);
        if (match) { this.loadError = { at: Date.now(), text: match[1].trim() || 'server code failed to load' }; tail = ''; }
      });
    }
    this.child = child;
    this.save({ childPid: child.pid });
    return child;
  }

  async stopChild() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const group = () => { try { process.kill(-child.pid, 0); return true; } catch { return false; } };
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    const deadline = Date.now() + 20_000;
    while (group() && Date.now() < deadline) await delay(100);
    if (group()) { log('The game did not stop within 20 s — SIGKILL (the last checkpoint is at most ~2 s old).'); try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    this.save({ childPid: null });
  }

  /** Healthy = `/health` reports this exact version with no error, and still does after a short soak. */
  async waitHealthy(sha, timeout, soak = this.c.soakMs, since = Date.now()) {
    const deadline = Date.now() + timeout;
    let last = 'no response';
    while (Date.now() < deadline && !this.stopping) {
      if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error('the game process exited before it became healthy');
      if (this.loadError && this.loadError.at >= since) throw new Error(`server code failed to load: ${this.loadError.text}`);
      const health = await this.health();
      if (health?.version === sha && health.error) throw new Error(`code error: ${health.error}`);
      if (health?.ok && health.version === sha) {
        if (soak) {
          await delay(soak);
          const again = await this.health();
          if (!again?.ok || again.version !== sha) throw new Error(`error after start: ${again?.error ?? 'no response'}`);
        }
        return;
      }
      if (health) last = `version ${short(health.version)}${health.error ? `, error: ${health.error}` : ''}`;
      await delay(250);
    }
    throw new Error(this.stopping ? 'stopped' : `not confirmed within ${Math.round(timeout / 1000)} s (${last})`);
  }

  async health() {
    try {
      const response = await fetch(`http://127.0.0.1:${this.c.port}/health`, { signal: AbortSignal.timeout(1500), cache: 'no-store' });
      return await response.json();
    } catch { return null; }
  }

  crashed() {
    const child = this.child;
    this.child = null;
    const now = Date.now();
    this.crashes = [...this.crashes.filter(at => now - at < 120_000), now];
    const wait = Math.min(30_000, 1000 * 2 ** (this.crashes.length - 1));
    this.restartAt = now + wait;
    log(`The game process exited (${child.exitCode ?? child.signalCode}). Restarting in ${wait / 1000} s.`);
    this.save({ status: 'crashed', childPid: null, error: `game process exited (${child.exitCode ?? child.signalCode})` });
  }

  async revive() {
    try {
      await this.mode.startCurrent();
      this.save({ status: 'running', error: null });
    } catch (error) {
      await this.stopChild();
      const wait = Math.min(30_000, 2000 * 2 ** this.crashes.length);
      this.crashes.push(Date.now());
      this.restartAt = Date.now() + wait;
      log(`Could not start the game: ${error.message}. Next attempt in ${wait / 1000} s.`);
      this.save({ status: 'crashed', error: error.message });
    }
  }
}

// ── live mode ───────────────────────────────────────────────────────

class LiveMode {
  constructor(sup) { this.s = sup; }

  env(sha) {
    const { c, p } = this.s;
    return {
      ...process.env, NODE_ENV: 'development',
      GAIME_PORT: String(c.port), GAIME_DATA_DIR: c.dataDir, GAIME_VERSION: sha,
      GAIME_VERSION_FILE: p.versionFile, GAIME_APPLYING_FILE: p.applying,
    };
  }

  async boot(sha) {
    const { s } = this;
    clearPublic(s.c.publicDir);
    const live = s.p.live;
    const current = s.state.current?.sha;
    const intact = current === sha && existsSync(join(live, 'node_modules')) && s.state.live?.sha === sha && s.state.live?.depsKey === safe(() => depsKey(live)) && !existsSync(s.p.applying);
    if (!intact) await this.rebuild(sha);
    writeAtomic(s.p.versionFile, sha, 0o644);
    await this.startChild(sha);
    s.save({ current: { sha, at: new Date().toISOString() }, attempted: sha });
    log(`Game ready: http://localhost:${s.c.port} • ${short(sha)} (live, HMR)`);
  }

  /** Fresh live tree for `sha` (only while no game process runs). */
  async rebuild(sha) {
    const { s } = this;
    const candidate = s.workDir('live');
    extract(s.c.repoRoot, sha, candidate);
    const key = depsKey(candidate);
    const live = s.p.live;
    if (existsSync(join(live, 'node_modules')) && s.state.live?.depsKey === key) {
      // Workspace links inside node_modules are relative, so they follow the move.
      for (const dir of ['', ...workspaces(candidate)]) {
        const from = join(live, dir, 'node_modules');
        if (existsSync(from)) { mkdirSync(join(candidate, dir), { recursive: true }); renameSync(from, join(candidate, dir, 'node_modules')); }
      }
    } else await s.install(candidate);
    this.swap(candidate);
    rmSync(`${live}.old`, { recursive: true, force: true });
    s.save({ live: { sha, depsKey: key } });
  }

  swap(candidate) {
    const live = this.s.p.live;
    rmSync(`${live}.old`, { recursive: true, force: true });
    if (existsSync(live)) renameSync(live, `${live}.old`);
    renameSync(candidate, live);
  }

  async startChild(sha) {
    const { s } = this;
    s.spawnChild(join(s.p.live, s.c.gamePath), ['run', 'dev'], this.env(sha));
    await s.waitHealthy(sha, s.c.startTimeout, 0);
  }

  async startCurrent() {
    const sha = this.s.state.live?.sha ?? this.s.state.current.sha;
    await this.startChild(sha);
  }

  async deploy(sha, { gates = true, check = true } = {}) {
    const { s } = this;
    const previous = s.state.current?.sha;
    const candidate = s.workDir('candidate');
    extract(s.c.repoRoot, sha, candidate);
    const key = depsKey(candidate);
    const files = changedFiles(s.c.repoRoot, s.state.live?.sha ?? previous, sha);
    // Vite reads its config (and the gaime plugin) once: such changes need a process restart.
    const config = files === null || files.some(file => this.restartFile(file));
    if (files?.some(file => file.startsWith('packages/host/'))) log('Note: the supervisor code (packages/host) changed — it takes effect after restarting "gaime host".');

    if (!s.child || key !== s.state.live?.depsKey || config) {
      // Dependencies changed: install next to the running game, then a short restart.
      if (key !== s.state.live?.depsKey) await s.install(candidate);
      else linkNodeModules(s.p.live, candidate);
      if (gates) await s.gates(candidate);
      if (check && await s.superseded(sha)) return 'superseded';
      const snapshot = s.snapshot(`before-${short(sha)}`);
      s.save({ status: 'restarting' });
      await s.stopChild();
      if (key === s.state.live?.depsKey) {
        // Same dependencies: move the real install over (only once nothing runs from it).
        for (const dir of ['', ...workspaces(candidate)]) {
          rmSync(join(candidate, dir, 'node_modules'), { recursive: true, force: true });
          const from = join(s.p.live, dir, 'node_modules');
          if (existsSync(from)) renameSync(from, join(candidate, dir, 'node_modules'));
        }
      }
      const oldLive = s.state.live;
      this.swap(candidate);
      writeAtomic(s.p.versionFile, sha, 0o644);
      s.save({ live: { sha, depsKey: key } });
      try {
        await this.startChild(sha);
        await s.waitHealthy(sha, s.c.startTimeout);
      } catch (error) {
        await s.stopChild();
        const live = s.p.live;
        if (existsSync(`${live}.old`)) {
          // Give a moved (shared) install back to the old tree before discarding the candidate.
          for (const dir of ['', ...workspaces(live)]) {
            const moved = join(live, dir, 'node_modules');
            const home = join(`${live}.old`, dir, 'node_modules');
            if (existsSync(moved) && !existsSync(home) && existsSync(join(`${live}.old`, dir))) renameSync(moved, home);
          }
          rmSync(live, { recursive: true, force: true });
          renameSync(`${live}.old`, live);
        }
        s.restoreCheckpoint(snapshot);
        s.save({ live: oldLive });
        if (previous) {
          writeAtomic(s.p.versionFile, previous, 0o644);
          try { await this.startChild(previous); } catch (restore) { log(`Restoring ${short(previous)}: ${restore.message}`); }
        }
        throw error;
      }
      rmSync(`${s.p.live}.old`, { recursive: true, force: true });
      s.save({ current: { sha, at: new Date().toISOString() }, previous: previous ? { sha: previous } : s.state.previous });
      return 'restart';
    }

    // Same dependencies: hot update.
    linkNodeModules(s.p.live, candidate);
    if (gates) await s.gates(candidate);
    if (check && await s.superseded(sha)) return 'superseded';
    s.snapshot(`before-${short(sha)}`);
    s.save({ status: 'applying' });
    const since = Date.now();
    const changes = this.apply(candidate, sha);
    log(`Synced ${changes.changed.length} changed and ${changes.removed.length} removed files — hot reload…`);
    try {
      await s.waitHealthy(sha, s.c.hmrTimeout, s.c.soakMs, since);
    } catch (error) {
      if (previous) {
        log(`Hot reload of ${short(sha)} failed — restoring ${short(previous)}.`);
        const back = s.workDir('revert');
        extract(s.c.repoRoot, previous, back);
        this.apply(back, previous);
        try { await s.waitHealthy(previous, s.c.hmrTimeout, 0); } catch (revert) { log(`Restore: ${revert.message}`); }
      }
      throw error;
    }
    s.save({ current: { sha, at: new Date().toISOString() }, previous: previous ? { sha: previous } : s.state.previous });
    return 'hot reload';
  }

  restartFile(file) {
    const game = this.s.c.gamePath ? `${this.s.c.gamePath}/` : '';
    return file.startsWith('packages/core/src/vite/') || new RegExp(`^${game.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}vite\\.config\\.`).test(file) || /^tsconfig.*\.json$/.test(file);
  }

  apply(tree, sha) {
    const { s } = this;
    writeFileSync(s.p.applying, sha);
    let changes;
    try {
      changes = syncTree(tree, s.p.live);
      writeAtomic(s.p.versionFile, sha, 0o644);
      s.save({ live: { ...s.state.live, sha } });
    } finally {
      rmSync(s.p.applying, { force: true });
    }
    // Reload the backend even when only client files or assets changed, so /health confirms the version.
    touch(join(s.p.live, s.c.gamePath, s.c.serverEntry));
    return changes;
  }

  async rollback() {
    const { s } = this;
    const target = s.state.previous?.sha;
    if (!target) throw new Error('There is no previous version to roll back to.');
    const current = s.state.current?.sha;
    await this.deploy(target, { gates: false, check: false });
    s.save({ previous: current ? { sha: current } : null, attempted: current ?? s.state.attempted });
  }
}

// ── release mode ────────────────────────────────────────────────────

class ReleaseMode {
  constructor(sup) { this.s = sup; }

  clientDir(release) { return join(release.dir, this.s.c.gamePath, 'dist', 'client'); }
  canStart(release) { return !!release?.dir && existsSync(join(release.dir, this.s.c.gamePath, 'dist', 'server', 'server.mjs')); }

  async boot(sha) {
    const { s } = this;
    if (s.state.pending) {
      // The previous supervisor died mid-deploy: return to the last good pair of code + save.
      log('The previous deploy was interrupted — restoring the last working release and its checkpoint.');
      s.restoreCheckpoint(s.state.pending.snapshot);
      s.save({ current: s.state.pending.old ?? null, pending: null, paused: true });
    }
    markDeploying(s.c.publicDir, s.state.current?.sha ?? null);
    const current = s.state.current;
    if (current?.sha === sha && this.canStart(current)) {
      await this.startRelease(current);
      s.save({ attempted: sha });
    } else {
      await this.deploy(sha, { check: false });
    }
  }

  async startRelease(release) {
    const { s } = this;
    s.spawnChild(join(release.dir, s.c.gamePath), ['run', 'start'], {
      ...process.env, NODE_ENV: 'production', GAIME_PORT: String(s.c.port), GAIME_DATA_DIR: s.c.dataDir, GAIME_VERSION: release.sha,
    });
    await s.waitHealthy(release.sha, s.c.startTimeout);
    publish(this.clientDir(release), s.c.publicDir, release.sha, s.c.game);
    log(`Game ready: http://localhost:${s.c.port} • ${short(release.sha)} (release)`);
  }

  async startCurrent() {
    await this.startRelease(this.s.state.current);
  }

  async prepare(sha) {
    const { s } = this;
    mkdirSync(s.p.releases, { recursive: true });
    const dir = join(s.p.releases, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${sha.slice(0, 12)}`);
    rmSync(dir, { recursive: true, force: true });
    try {
      extract(s.c.repoRoot, sha, dir);
      const key = depsKey(dir);
      const store = join(s.p.deps, key);
      if (!existsSync(join(store, '.ready'))) {
        // Install once per dependency set; every release links to the shared store.
        await s.install(dir);
        rmSync(store, { recursive: true, force: true });
        for (const ws of ['', ...workspaces(dir)]) {
          const from = join(dir, ws, 'node_modules');
          if (!existsSync(from)) continue;
          mkdirSync(join(store, ws), { recursive: true });
          renameSync(from, join(store, ws, 'node_modules'));
        }
        writeFileSync(join(store, '.ready'), sha);
      }
      linkNodeModules(store, dir);
      await s.gates(dir);
      log(`Building ${short(sha)}…`);
      await run('npm', ['run', 'build'], {
        cwd: join(dir, s.c.gamePath), timeout: 600_000,
        env: { ...process.env, NODE_ENV: 'production', GAIME_VERSION: sha, GAIME_PORT: String(s.c.port) },
      });
      const release = { sha, dir, depsKey: key };
      if (!this.canStart(release)) throw new Error('the build did not produce dist/server/server.mjs');
      preparePublic(this.clientDir(release), s.c.publicDir);
      return release;
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async deploy(sha, { check = true } = {}) {
    const { s } = this;
    const old = s.state.current?.dir && existsSync(s.state.current.dir) ? s.state.current : null;
    const release = await this.prepare(sha);
    if (check && await s.superseded(sha)) { rmSync(release.dir, { recursive: true, force: true }); return 'superseded'; }
    markDeploying(s.c.publicDir, old?.sha ?? null);
    s.save({ status: 'restarting' });
    await s.stopChild();
    const snapshot = s.snapshot(`before-${short(sha)}`);
    s.save({ pending: { release, old, snapshot } });
    try {
      await this.startRelease(release);
    } catch (error) {
      await s.stopChild();
      s.restoreCheckpoint(snapshot);
      s.save({ pending: null });
      if (old && this.canStart(old)) {
        try { await this.startRelease(old); } catch (restore) { log(`Restoring ${short(old.sha)}: ${restore.message}`); }
      }
      rmSync(release.dir, { recursive: true, force: true });
      throw error;
    }
    s.save({ current: release, previous: old ? { ...old, checkpoint: snapshot } : s.state.previous, pending: null });
    this.prune();
    return 'restart';
  }

  async rollback() {
    const { s } = this;
    const previous = s.state.previous;
    if (!previous?.dir || !this.canStart(previous)) throw new Error('There is no previous release to roll back to.');
    const current = s.state.current;
    markDeploying(s.c.publicDir, current?.sha ?? null);
    await s.stopChild();
    s.snapshot(`rollback-from-${short(current?.sha)}`);
    // Code and save go back together: newer saves may not be readable by older code.
    if (previous.checkpoint) s.restoreCheckpoint(previous.checkpoint);
    await this.startRelease(previous);
    s.save({ current: { sha: previous.sha, dir: previous.dir, depsKey: previous.depsKey }, previous: null, attempted: current?.sha ?? s.state.attempted });
  }

  prune() {
    const { s } = this;
    const keep = new Set([s.state.current?.dir, s.state.previous?.dir].filter(Boolean));
    const releases = readdirSync(s.p.releases).map(name => join(s.p.releases, name)).filter(dir => statSync(dir).isDirectory()).sort();
    for (const dir of releases.slice(0, -4)) if (!keep.has(dir)) rmSync(dir, { recursive: true, force: true });
    const used = new Set([s.state.current?.depsKey, s.state.previous?.depsKey].filter(Boolean));
    if (!existsSync(s.p.deps)) return;
    for (const key of readdirSync(s.p.deps)) {
      const inUse = used.has(key) || readdirSync(s.p.releases).some(name => safe(() => depsKey(join(s.p.releases, name))) === key);
      if (!inUse) rmSync(join(s.p.deps, key), { recursive: true, force: true });
    }
  }
}

function safe(fn) { try { return fn(); } catch { return undefined; } }

async function ensureFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is taken. Stop your local "npm run dev" or set GAIME_PORT. The supervisor never kills other processes.`)));
    server.listen(port, '0.0.0.0', () => server.close(resolve));
  });
}
