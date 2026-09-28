import type { BaseWorld, Data, Pause } from '../shared/types';
import type { GameDefinition } from './game';
import { Engine } from './engine';
import { worldHash, type Entry, type Recording, type ReplayResult } from './recorder';

export interface ReplayOptions {
  /** Stop at this tick (default: the end of the recording). */
  until?: number;
  /** Called after every replayed tick — inspect the world, collect data, set breakpoints. */
  onTick?(world: unknown, tick: number): void;
}

type Command = { type: string; [key: string]: unknown };

/**
 * Replays a recording (from `gaime replay`, an automatic save after an error, or `testGame`'s
 * `recording()`) with the current code: the same world snapshot, the same inputs and commands at
 * the same ticks. Verifies the world hash every few seconds against the recording and reports the
 * first divergence — which means non-deterministic code (Math.random, Date.now, iteration over
 * something unordered) or different code than the one recorded.
 *
 *   const result = replay(game, JSON.parse(readFileSync('replay.json', 'utf8')));
 *   expect(result.diverged).toBeUndefined();
 */
export function replay<W extends BaseWorld, I>(game: GameDefinition<W, I, any, any>, recording: Recording, options: ReplayOptions = {}): ReplayResult<W> {
  if (recording.game !== game.name) throw new Error(`This recording belongs to game "${recording.game}", not "${game.name}".`);
  const [first, ...rest] = recording.segments;
  if (!first) throw new Error('The recording has no segments.');
  const engine = new Engine<W, I>(game as GameDefinition<W, I>, { notify() {}, send() {}, replaying: true }, structuredClone(first.world) as W);
  engine.loadState(first.state);
  const inputs: Record<string, I> = structuredClone(first.state.inputs) as Record<string, I>;
  const until = options.until ?? Infinity;
  const checks = new Map<number, string>();
  let verified = 0;
  let ticks = 0;
  let diverged: ReplayResult<W>['diverged'];

  const advance = (tick: number) => {
    while (engine.world.tick < tick && engine.world.tick < until && !diverged) {
      const before = engine.world.tick;
      engine.step(inputs);
      if (engine.world.tick === before) {
        diverged = { tick: before, expected: `tick ${tick}`, actual: 'the game stayed paused' };
        return;
      }
      ticks++;
      options.onTick?.(engine.world, engine.world.tick);
      const expected = checks.get(engine.world.tick);
      if (expected === undefined) continue;
      const actual = worldHash(engine.world);
      if (actual === expected) verified++;
      else diverged = { tick: engine.world.tick, expected, actual };
    }
  };

  const apply = ([, type, ...args]: Entry) => {
    switch (type) {
      case 'in': { const [id, input] = args as [string, I | null]; if (input === null) delete inputs[id]; else inputs[id] = input; break; }
      case 'cmd': engine.command(args[0] as string, args[1] as Command); break;
      case 'join': engine.addPlayer(args[0] as string, args[1] as string, (args[2] as Data | null) ?? undefined); break;
      case 'online': engine.setOnline(args[0] as string, args[1] as boolean); break;
      case 'release': engine.release(args[0] as string); break;
      case 'remove': engine.ctx.removePlayer(args[0] as string); break;
      case 'bot': engine.addBot((args[0] as string | null) ?? undefined); break;
      case 'name': engine.setName(args[0] as string, args[1] as string); break;
      case 'say': engine.say(args[0] as string); break;
      case 'pause': engine.setPause(args[0] as Pause | null); break;
      case 'admin': try { engine.admin(args[0] as string, args[1] as string[]); } catch { /* it failed live too */ } break;
      case 'req': try { void engine.request(args[0] as string, args[1] as string, args[2]); } catch { /* it failed live too */ } break;
      case 'job': engine.replayJob(args[0] as number, args[1] as boolean, args[2]); break;
      case 'throttle': engine.setThrottle(args[0] as string, args[1] as number); break;
      default: throw new Error(`Unknown replay entry "${type}".`);
    }
  };

  for (const [index, segment] of [first, ...rest].entries()) {
    if (index > 0 && !diverged) {
      advance(segment.startTick);
      // Each segment starts with a snapshot: the replayed world must match it exactly.
      const expected = worldHash(segment.world);
      const actual = worldHash(engine.world);
      if (actual === expected) verified++;
      else diverged = { tick: segment.startTick, expected, actual };
    }
    for (const [tick, hash] of segment.checks) checks.set(tick, hash);
    for (const entry of segment.entries) {
      if (diverged || entry[0] > until) break;
      advance(entry[0]);
      if (diverged) break;
      apply(entry);
    }
    if (diverged) break;
    advance(segment.endTick);
  }
  return { world: engine.world, engine, ticks, verified, ...(diverged ? { diverged } : {}) };
}
