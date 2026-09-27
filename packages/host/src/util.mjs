import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function log(message) {
  console.log(`[gaime ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/** Write via rename so readers (status, backups, nginx) never see half a file. */
export function writeAtomic(path, contents, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temp, typeof contents === 'string' || Buffer.isBuffer(contents) ? contents : JSON.stringify(contents, null, 2), { mode });
  renameSync(temp, path);
}

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Run a command, streaming its output; rejects on non-zero exit or timeout. */
export function run(command, args, { cwd, env = process.env, timeout = 300_000, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '';
    if (quiet) { child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; }); }
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} ${args.join(' ')}: timed out after ${Math.round(timeout / 1000)} s`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}${quiet && output ? `:\n${output.slice(-2000)}` : ''}`));
    });
  });
}

export const short = sha => (sha ? sha.slice(0, 8) : '—');
