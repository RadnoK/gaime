#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveConfig, sendControl, paths, Supervisor } from '../src/supervisor.mjs';
import { smoke } from '../src/smoke.mjs';
import { load } from '../src/load.mjs';
import { newGame, templates } from '../src/new-game.mjs';
import { git } from '../src/git.mjs';
import { alive, delay, flagValue, readJson, short } from '../src/util.mjs';

const HELP = `gaime — game tools (run inside a game directory, e.g. games/starter)

Hosting and deploys
  gaime host                   supervisor: follows origin/main and deploys every commit
  gaime status [--json]        supervisor state, live version, deploy history
  gaime rollback               go back to the previous version and pause updates
  gaime resume | pause         resume / pause automatic updates
  gaime redeploy               retry deploying the newest commit
  gaime restart                restart the game process (the checkpoint stays)

Running game (admin API, token from GAIME_ADMIN_TOKEN or <data>/admin-token)
  gaime players                players (online, host)
  gaime say <text>             announcement in the game feed
  gaime kick <nick>            remove a player
  gaime world [key]            world dump (JSON), optionally a single field
  gaime game pause|resume|save pause/resume the simulation, force a checkpoint
  gaime admin [command] [...]  commands defined by the game (GameDefinition.admin)

Tests
  gaime smoke [url] [--hmr]    end-to-end test with real WebSocket clients
  gaime load [url] [--bots 20] [--seconds 20] [--rate 20] [--input '<json>'] [--chat 0.2]
                               load and latency test (bots, RTT p50/p99, tick cost)

Creating
  gaime new <name> [--title "Title"] [--from blank|starter|duel|…]   new game in games/<name>
  gaime new --list             templates you can start from

Environment: GAIME_MODE=live|release, GAIME_PORT, GAIME_URL, GAIME_BRANCH, GAIME_REMOTE, GAIME_POLL_MS,
GAIME_GATES (e.g. "check,test"), GAIME_DATA_DIR, GAIME_STATE_DIR, GAIME_PUBLIC_DIR, GAIME_PUBLIC_URL,
GAIME_LATENCY_MS (simulated server round trip). Details: docs/DEPLOYMENT.md, docs/PROTOCOL.md`;

const [command = 'help', ...args] = process.argv.slice(2);
const flag = (name, fallback) => flagValue(args, name, fallback);
const VALUED = new Set(['--bots', '--seconds', '--rate', '--input', '--chat', '--title', '--from']);
const positional = () => args.filter((arg, i) => !arg.startsWith('--') && !VALUED.has(args[i - 1]));

function config() {
  try { return resolveConfig(); } catch { return null; }
}

function target() {
  const c = config();
  const state = c ? readJson(paths(c).state, {}) : {};
  // A host.json left by a supervisor that is not running says nothing about the game on this machine.
  const supervised = alive(state.pid);
  const url = process.env.GAIME_URL ?? `http://127.0.0.1:${process.env.GAIME_PORT ?? (supervised ? state.port : undefined) ?? 5173}`;
  // Candidates in order of likelihood; `admin` tries the next one on 401.
  const dirs = supervised ? [c?.dataDir, resolve('.gaime/data')] : [resolve('.gaime/data'), c?.dataDir];
  const tokens = [process.env.GAIME_ADMIN_TOKEN];
  for (const dir of [process.env.GAIME_DATA_DIR, ...dirs]) {
    const file = dir && join(dir, 'admin-token');
    if (file && existsSync(file)) tokens.push(readFileSync(file, 'utf8').trim());
  }
  return { url, tokens: [...new Set(tokens.filter(Boolean))] };
}

async function admin(action, body) {
  const { url, tokens } = target();
  if (!tokens.length) throw new Error('No admin token: set GAIME_ADMIN_TOKEN or run inside the directory of a game that is running.');
  let response;
  for (const token of tokens) {
    response = await fetch(`${url}/gaime/admin/${action}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    }).catch(error => { throw new Error(`Cannot reach ${url}: ${error.message}`); });
    if (response.status !== 401) break;
  }
  const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

const print = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

try {
  switch (command) {
    case 'host':
    case 'start':
      await new Supervisor(resolveConfig()).start();
      break;
    case 'status': {
      const c = resolveConfig();
      const json = args.includes('--json');
      const state = readJson(paths(c).state, null);
      if (!state) {
        if (json) print({ state: null, stateDir: c.stateDir }); else console.log(`No state in ${c.stateDir}. The supervisor has not run yet.`);
        break;
      }
      let health = null;
      const base = process.env.GAIME_URL ?? `http://127.0.0.1:${state.port ?? c.port}`;
      try { health = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })).json(); } catch {}
      const running = alive(state.pid);
      if (json) { print({ ...state, running, health }); break; }
      console.log(`${c.game} · ${state.mode} · ${running ? `supervisor PID ${state.pid}` : 'supervisor not running'} · ${state.status}${state.paused ? ' · UPDATES PAUSED' : ''}`);
      console.log(`version: ${short(state.current?.sha)}   previous: ${short(state.previous?.sha)}   game /health: ${health ? `${health.ok ? 'ok' : 'ERROR'} ${short(health.version)}${health.error ? ` — ${health.error}` : ''}` : 'no response'}`);
      if (state.failed) console.log(`last failed commit: ${short(state.failed.sha)} — ${state.failed.error}`);
      if (state.error && state.error !== state.failed?.error) console.log(`last error: ${state.error}`);
      for (const entry of (state.history ?? []).slice(0, 8)) console.log(`  ${entry.at?.slice(0, 19).replace('T', ' ')}  ${short(entry.sha)}  ${entry.result}${entry.seconds ? ` ${entry.seconds}s` : ''}  ${entry.subject ?? ''}${entry.error ? ` — ${entry.error}` : ''}`);
      break;
    }
    case 'rollback': case 'resume': case 'pause': case 'redeploy': case 'restart': {
      const c = resolveConfig();
      const state = readJson(paths(c).state, {});
      if (!alive(state.pid)) { console.error('The supervisor is not running — start it first: gaime host'); process.exitCode = 1; break; }
      const id = sendControl(c, command);
      // The supervisor handles controls between deploys: wait for its acknowledgement a while.
      const deadline = Date.now() + (command === 'rollback' ? 180_000 : 30_000);
      let control;
      while (Date.now() < deadline && alive(state.pid) && (control = readJson(paths(c).state, {}).control)?.id !== id) await delay(250);
      if (control?.id !== id) console.log(`Requested "${command}" — the supervisor has not handled it yet (busy deploying?). See: gaime status`);
      else if (control.ok) console.log(`Done: ${command}.`);
      else { console.error(`${command} failed: ${control.error}`); process.exitCode = 1; }
      break;
    }
    case 'players': {
      const players = await admin('players');
      for (const p of players) console.log(`${p.online ? '●' : '○'} ${p.host ? '👑 ' : ''}${p.name}  ${p.id}`);
      if (!players.length) console.log('No players.');
      break;
    }
    case 'say': print(await admin('say', { text: positional().join(' ') })); break;
    case 'kick': print(await admin('kick', { player: positional().join(' ') })); break;
    case 'world': {
      const world = await admin('world');
      const key = positional()[0];
      print(key ? key.split('.').reduce((value, part) => value?.[part], world) : world);
      break;
    }
    case 'game': {
      const action = positional()[0];
      if (!['pause', 'resume', 'save'].includes(action)) throw new Error('Usage: gaime game pause|resume|save');
      print(await admin(action, {}));
      break;
    }
    case 'admin': {
      const [name, ...rest] = positional();
      if (!name) {
        const commands = await admin('commands');
        for (const [key, description] of Object.entries(commands)) console.log(`  ${key.padEnd(14)} ${description}`);
        if (!Object.keys(commands).length) console.log('The game defines no admin commands (GameDefinition.admin).');
      } else print(await admin('command', { name, args: rest }));
      break;
    }
    case 'smoke': {
      const url = positional()[0] ?? target().url;
      await smoke({ url, hmr: args.includes('--hmr') });
      break;
    }
    case 'load': {
      const url = positional()[0] ?? target().url;
      await load({
        url, bots: Number(flag('bots', 20)), seconds: Number(flag('seconds', 20)), rate: Number(flag('rate', 20)),
        input: flag('input', process.env.GAIME_LOAD_INPUT), chat: Number(flag('chat', 0)),
      });
      break;
    }
    case 'new': {
      let root = process.cwd();
      try { root = git(process.cwd(), 'rev-parse', '--show-toplevel'); } catch {}
      const name = positional()[0];
      if (!name || args.includes('--list')) {
        console.log('Templates (gaime new <name> --from <template>):');
        for (const template of templates(root)) console.log(`  ${template.name.padEnd(12)} ${template.description}`);
        if (!name) break;
      }
      const result = newGame({ root, name, title: flag('title'), from: flag('from', 'blank') });
      console.log(`Created ${result.path} ("${result.title}").\n\nNext:\n  npm install\n  npm run dev -- ${name}\n\nThen: git add ${result.path} package-lock.json && git commit && git push — and set up hosting (docs/DEPLOYMENT.md).`);
      break;
    }
    default:
      console.log(HELP);
      if (command !== 'help' && command !== '--help') process.exitCode = 1;
  }
} catch (error) {
  console.error(`gaime ${command}: ${error.message}`);
  process.exitCode = 1;
}
