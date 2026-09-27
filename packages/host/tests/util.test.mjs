import { expect, test, vi } from 'vitest';
import { flagValue } from '../src/util.mjs';
import { envNumber } from '../src/supervisor.mjs';

test('the last occurrence of a flag wins, so npm run x -- --flag overrides a preset', () => {
  const args = ['--bots', '2', '--input', '{"a":1}', '--bots', '50'];
  expect(flagValue(args, 'bots', 20)).toBe('50');
  expect(flagValue(args, 'input')).toBe('{"a":1}');
  expect(flagValue(args, 'seconds', 20)).toBe(20);
  expect(flagValue(['--bots'], 'bots', 20)).toBe(20);
});

test('numeric settings fall back to the default on a typo', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(envNumber({ GAIME_POLL_MS: '5000' }, 'GAIME_POLL_MS', 3000)).toBe(5000);
  expect(envNumber({}, 'GAIME_POLL_MS', 3000)).toBe(3000);
  expect(envNumber({ GAIME_POLL_MS: '' }, 'GAIME_POLL_MS', 3000)).toBe(3000);
  expect(log).not.toHaveBeenCalled();
  expect(envNumber({ GAIME_POLL_MS: '3s' }, 'GAIME_POLL_MS', 3000)).toBe(3000);
  expect(envNumber({ GAIME_POLL_MS: '5' }, 'GAIME_POLL_MS', 3000, 100)).toBe(3000);
  expect(log).toHaveBeenCalledTimes(2);
  log.mockRestore();
});
