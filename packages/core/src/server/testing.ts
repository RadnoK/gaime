import type { BaseWorld, PlayerOf } from '../shared/types';
import { findPlayer, nextId, pushFeed } from '../shared/world';
import type { GameContext } from './game';

/**
 * A GameContext for unit tests of game logic, without a room or network.
 * Collects notices and events; `flushJobs()` applies finished `ctx.job` results.
 */
export function testContext<W extends BaseWorld>(world: W, options: { random?: () => number; command?: (playerId: string, command: { type: string; [key: string]: unknown }) => string | void } = {}) {
  const notices: Array<{ playerId: string; text: string }> = [];
  const events: Array<{ name: string; data: unknown; playerId?: string }> = [];
  const removed: string[] = [];
  const jobs: Array<Promise<void>> = [];
  const ready: Array<() => void> = [];
  const ctx: GameContext<W> = {
    world,
    log: text => { pushFeed(world, text); },
    notify: (playerId, text) => { notices.push({ playerId, text }); },
    nextId: () => nextId(world),
    random: options.random ?? Math.random,
    isHost: id => world.hostId === id,
    removePlayer: id => { removed.push(id); delete world.players[id]; },
    save: () => {},
    emit: (name, data, playerId) => { events.push({ name, data, playerId }); },
    job: (work, apply, fail) => {
      jobs.push(work.then(result => { ready.push(() => apply(world, result, ctx)); }, error => { ready.push(() => fail?.(world, error, ctx)); }));
    },
    findPlayer: query => findPlayer(world.players, query) as PlayerOf<W> | undefined,
    addBot: () => { throw new Error('testContext: add bots with createPlayer + data["gaime-bot"] = true, or test through a real server.'); },
    isBot: id => !!world.players[id]?.data['gaime-bot'],
    command: (playerId, command) => options.command?.(playerId, command),
  };
  return {
    ctx, notices, events, removed,
    /** Wait for pending jobs and apply them, like the next tick would. */
    async flushJobs() { await Promise.all(jobs.splice(0)); for (const apply of ready.splice(0)) apply(); },
  };
}
