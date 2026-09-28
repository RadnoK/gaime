import { expect, test } from 'vitest';
import { roomUrl } from '../src/client/client';
import { ServerClock } from '../src/client/interpolation';

test('GameClient asks the configured server, not the page, for the room id', () => {
  const page = 'https://game.example.com/play/?player=x';
  expect(roomUrl(undefined, page)).toBe('https://game.example.com/gaime/room');
  expect(roomUrl('ws://localhost:2567', page)).toBe('http://localhost:2567/gaime/room');
  expect(roomUrl('wss://api.example.com/', page)).toBe('https://api.example.com/gaime/room');
  expect(roomUrl('https://api.example.com/sub/', page)).toBe('https://api.example.com/sub/gaime/room');
});

/** Feeds `seconds` of patches every `interval` s, each delivered `base` + up to `jitter` s late. */
function feed(clock: ServerClock, interval: number, seconds: number, jitter = 0, base = 0.02) {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let t = 0; t <= seconds; t += interval) clock.sync(t, (t + base + random() * jitter) * 1000);
  return seconds;
}

test('ServerClock shrinks the interpolation delay to one patch interval on a steady connection', () => {
  const slow = new ServerClock();
  feed(slow, 1 / 15, 20);
  expect(slow.delay).toBeGreaterThan(1 / 15);
  expect(slow.delay).toBeLessThan(0.085);

  const fast = new ServerClock();
  feed(fast, 1 / 60, 20);
  expect(fast.delay).toBeLessThan(0.035);
});

test('ServerClock keeps a patch ahead of the render time under jitter', () => {
  const clock = new ServerClock();
  const end = feed(clock, 1 / 30, 20, 0.04);
  expect(clock.delay).toBeGreaterThan(1 / 30 + 0.03);
  expect(clock.delay).toBeLessThan(0.25);
  // Rendering at the automatic delay stays behind the newest patch the client has.
  expect(clock.now(undefined, (end + 0.02) * 1000)).toBeLessThan(end);
  // An explicit delay still wins.
  expect(clock.now(0.1, 5000)).toBeCloseTo(clock.now(0, 5000) - 0.1);
});

test('ServerClock ignores repeated and paused world times', () => {
  const clock = new ServerClock();
  for (let i = 0; i < 100; i++) clock.sync(3, 1000 + i * 50);
  expect(clock.delay).toBe(0.1);
});
