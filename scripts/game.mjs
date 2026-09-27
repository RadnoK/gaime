#!/usr/bin/env node
// `npm run <script> [-- <game> ...args]` from the repo root runs the script of one game.
// Game: first argument if it names a directory in games/, else $GAIME_GAME, else "starter" / the only game.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [script, ...rest] = process.argv.slice(2);
const games = readdirSync('games').filter(name => existsSync(join('games', name, 'package.json')));
let game = process.env.GAIME_GAME;
if (rest[0] && games.includes(rest[0])) game = rest.shift();
game ??= games.includes('starter') ? 'starter' : games[0];
if (!game || !games.includes(game)) { console.error(`No game "${game}". Available: ${games.join(', ')}`); process.exit(1); }
const result = spawnSync('npm', ['run', script, '-w', `games/${game}`, ...(rest.length ? ['--', ...rest] : [])], { stdio: 'inherit' });
process.exit(result.status ?? 1);
