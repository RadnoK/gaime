import { expect, test } from 'vitest';
import { roomUrl } from '../src/client/client';

test('GameClient asks the configured server, not the page, for the room id', () => {
  const page = 'https://game.example.com/play/?player=x';
  expect(roomUrl(undefined, page)).toBe('https://game.example.com/gaime/room');
  expect(roomUrl('ws://localhost:2567', page)).toBe('http://localhost:2567/gaime/room');
  expect(roomUrl('wss://api.example.com/', page)).toBe('https://api.example.com/gaime/room');
  expect(roomUrl('https://api.example.com/sub/', page)).toBe('https://api.example.com/sub/gaime/room');
});
