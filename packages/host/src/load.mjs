// Load and latency test: many real WebSocket bots against a running game.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const round = value => Math.round(value * 10) / 10;

/**
 * Input template: JSON where strings starting with `$` are generated per message:
 * `$rand` (-1..1), `$rand*25`, `$bool`, `$int(0,3)`, `$pick(a|b|c)`. Other values pass through.
 */
export function compileTemplate(source) {
  const template = typeof source === 'string' ? JSON.parse(source) : source;
  const generate = value => {
    if (Array.isArray(value)) return value.map(generate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, generate(v)]));
    if (typeof value !== 'string' || !value.startsWith('$')) return value;
    let match;
    if ((match = /^\$rand(?:\*(-?[\d.]+))?$/.exec(value))) return (Math.random() * 2 - 1) * Number(match[1] ?? 1);
    if (value === '$bool') return Math.random() < 0.5;
    if ((match = /^\$int\((-?\d+),\s*(-?\d+)\)$/.exec(value))) return Number(match[1]) + Math.floor(Math.random() * (Number(match[2]) - Number(match[1]) + 1));
    if ((match = /^\$pick\((.*)\)$/.exec(value))) { const options = match[1].split('|'); return options[Math.floor(Math.random() * options.length)]; }
    return value;
  };
  return () => generate(template);
}

export async function load({ url, bots = 10, seconds = 20, rate = 20, input, chat = 0, cwd = process.cwd(), ramp = 50 }) {
  const require = createRequire(join(cwd, 'package.json'));
  const { Client } = await import(pathToFileURL(require.resolve('@colyseus/sdk')).href);
  const nextInput = input ? compileTemplate(input) : null;
  const stats = { joined: 0, failed: 0, joinMs: [], rtt: [], patches: 0, bytes: 0, sent: 0, dropped: 0, errors: [], server: [] };
  const rooms = [];
  const timers = [];
  const deadline = Date.now() + seconds * 1000;

  console.log(`gaime load: ${bots} bots × ${seconds} s, input ${nextInput ? `${rate}/s` : 'off'}${chat ? `, chat ${chat}/s` : ''} → ${url}`);
  const { roomId } = await (await fetch(`${url}/gaime/room`)).json();

  async function bot(index) {
    const started = performance.now();
    try {
      const room = await new Client(url).joinById(roomId, { name: `bot-${index + 1}`, ticket: randomBytes(18).toString('base64url'), ephemeral: true });
      rooms.push(room);
      stats.joined++; stats.joinMs.push(performance.now() - started);
      room.reconnection.enabled = false;
      for (const type of ['welcome', 'patch']) room.onMessage(type, message => { stats.patches++; stats.bytes += JSON.stringify(message).length; });
      for (const type of ['event', 'response', 'notice', 'removed']) room.onMessage(type, () => {});
      room.onLeave(code => { if (Date.now() < deadline) { stats.dropped++; stats.errors.push(`bot-${index + 1}: disconnected (${code})`); } });
      if (nextInput) timers.push(setInterval(() => { if (room.connection.isOpen) { room.send('input', nextInput()); stats.sent++; } }, 1000 / rate));
      if (chat) timers.push(setInterval(() => { if (room.connection.isOpen && Math.random() < chat) { room.send('command', { type: '$chat', text: `ping ${Date.now()}` }); stats.sent++; } }, 1000));
      timers.push(setInterval(() => { if (room.connection.isOpen) room.ping(ms => stats.rtt.push(ms)); }, 1000));
    } catch (error) {
      stats.failed++; stats.errors.push(`bot-${index + 1}: ${error.message}`);
    }
  }

  const sampler = setInterval(async () => {
    try { stats.server.push(await (await fetch(`${url}/gaime/stats`, { cache: 'no-store' })).json()); } catch {}
  }, 2000);
  for (let i = 0; i < bots; i++) { void bot(i); await new Promise(r => setTimeout(r, ramp)); }
  const progress = setInterval(() => {
    const rtt = stats.rtt.slice(-bots * 3);
    process.stdout.write(`  ${Math.max(0, Math.round((deadline - Date.now()) / 1000))} s · online ${stats.joined - stats.dropped}/${bots} · RTT p50 ${round(percentile(rtt, 50))} ms · p99 ${round(percentile(rtt, 99))} ms\n`);
  }, 5000);
  await new Promise(r => setTimeout(r, Math.max(0, deadline - Date.now())));
  clearInterval(progress); clearInterval(sampler);
  for (const timer of timers) clearInterval(timer);
  for (const room of rooms) { try { await room.leave(true); } catch {} }

  const elapsed = seconds;
  const max = key => Math.max(0, ...stats.server.map(s => s[key]?.max ?? 0));
  const report = {
    bots: { requested: bots, joined: stats.joined, failed: stats.failed, dropped: stats.dropped },
    joinMs: { p50: round(percentile(stats.joinMs, 50)), p95: round(percentile(stats.joinMs, 95)) },
    rttMs: { p50: round(percentile(stats.rtt, 50)), p95: round(percentile(stats.rtt, 95)), p99: round(percentile(stats.rtt, 99)), max: round(Math.max(0, ...stats.rtt)) },
    perBot: { messagesInPerSecond: round(stats.patches / Math.max(1, stats.joined) / elapsed), approxKBInPerSecond: round(stats.bytes / 1024 / Math.max(1, stats.joined) / elapsed) },
    total: { messagesOutPerSecond: round(stats.sent / elapsed), approxKBInPerSecond: round(stats.bytes / 1024 / elapsed) },
    server: {
      tickMsMax: max('tickMs'), publishMsMax: max('publishMs'), patchBytesMax: max('patchBytes'),
      eventLoopP99Max: Math.max(0, ...stats.server.map(s => s.eventLoopDelayMs?.p99 ?? 0)),
      memoryMbMax: Math.max(0, ...stats.server.map(s => s.memoryMb ?? 0)),
    },
    errors: stats.errors.slice(0, 10),
  };
  console.log(JSON.stringify(report, null, 2));
  const tickRate = stats.server.find(s => s.tickRate > 0)?.tickRate ?? 30;
  const budget = 1000 / tickRate;
  if (report.server.tickMsMax > budget) console.log(`⚠ Server tick exceeded its ${round(budget)} ms budget — the simulation cannot keep up (consider workers or a lower publish rate).`);
  if (stats.failed || stats.dropped) process.exitCode = 1;
  return report;
}
