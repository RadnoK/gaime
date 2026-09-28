import type { BaseWorld } from '../shared/types';
import type { GameDefinition } from './game';
import type { Engine } from './engine';

/**
 * Flight recorder: everything that enters the simulation from outside — inputs (as changes),
 * commands, joins and leaves, bots, admin actions, requests, job results, throttling — stamped
 * with the tick it happened at. The simulation itself is deterministic (fixed step, `ctx.random`
 * from `world.rng`, timers in the world), so a snapshot plus these entries replays a session
 * exactly. Recordings are kept in segments (a snapshot each) covering the last few minutes.
 */
export type Entry = [tick: number, type: string, ...args: unknown[]];

export interface EngineState {
  systems: Record<string, [next: number, last: number]>;
  throttle: Record<string, number>;
  disabled: Record<string, string>;
  jobs: number;
  inputs: Record<string, unknown>;
  /** `ctx.resource` state that is not in the world (`ResourceOptions.save`). */
  resources?: Record<string, unknown>;
}

export interface Segment {
  startTick: number;
  endTick: number;
  world: unknown;
  state: EngineState;
  entries: Entry[];
  /** [tick, hash of the world after that tick] every CHECK_EVERY ticks: replay verifies them. */
  checks: Array<[number, string]>;
}

export interface Recording {
  format: 1;
  game: string;
  /** Code version that produced it: replay with the same code. */
  version: string;
  tickRate: number;
  savedAt: string;
  reason: string;
  segments: Segment[];
}

const CHECK_EVERY = 150;
/**
 * Entries per segment before a new one starts early: bounds the recorder's memory under heavy
 * traffic (3 segments × 100 000 entries ≈ 50 MB) — the window gets shorter instead of growing.
 */
const MAX_SEGMENT_ENTRIES = 100_000;

/** FNV-1a over the world's JSON: cheap, stable, good enough to spot a divergence. */
export function worldHash(world: unknown): string {
  const text = JSON.stringify(world);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export class Recorder<W extends BaseWorld> {
  readonly segments: Segment[] = [];
  private lastInputs = new Map<string, string>();
  private readonly segmentTicks: number;
  private readonly keep = 3;
  /** Recording stops (and says why) when something non-replayable happened. */
  broken: string | null = null;

  constructor(private readonly engine: Engine<W, any>, minutes: number, private readonly maxEntries = MAX_SEGMENT_ENTRIES) {
    // Three segments of half the window each always cover at least `minutes`.
    this.segmentTicks = Math.max(300, Math.round((minutes * 60) / 2 / engine.dt));
  }

  /** A fresh recording from the current world: after a load or a hot-reload restore replaced it. */
  restart() {
    this.segments.length = 0;
    this.broken = null;
    this.start();
  }

  /** A new segment from the current world (when the current one is full). */
  start() {
    const world = this.engine.world;
    const inputs: Record<string, unknown> = {};
    for (const [id, json] of this.lastInputs) inputs[id] = JSON.parse(json);
    this.segments.push({ startTick: world.tick, endTick: world.tick, world: structuredClone(world), state: this.engine.saveState(inputs), entries: [], checks: [] });
    while (this.segments.length > this.keep) this.segments.shift();
  }

  entry(type: string, ...args: unknown[]) {
    const segment = this.segments.at(-1);
    if (!segment || this.broken) return;
    segment.entries.push([this.engine.world.tick, type, ...structuredCloneSafe(args, () => { this.broken = `a "${type}" entry is not serialisable`; })]);
    if (segment.entries.length >= this.maxEntries) this.start();
  }

  /** Records only what changed since the last tick. */
  inputs(inputs: Readonly<Record<string, unknown>>) {
    for (const [id, input] of Object.entries(inputs)) {
      const json = JSON.stringify(input);
      if (this.lastInputs.get(id) === json) continue;
      this.lastInputs.set(id, json);
      this.entry('in', id, input);
    }
    for (const id of this.lastInputs.keys()) {
      if (id in inputs) continue;
      this.lastInputs.delete(id);
      this.entry('in', id, null);
    }
  }

  afterStep() {
    const segment = this.segments.at(-1);
    if (!segment) return;
    const tick = this.engine.world.tick;
    segment.endTick = tick;
    if (tick % CHECK_EVERY === 0) segment.checks.push([tick, worldHash(this.engine.world)]);
    if (tick - segment.startTick >= this.segmentTicks) this.start();
  }

  toJSON(game: GameDefinition<W, any>, version: string, reason: string): Recording {
    const last = this.segments.at(-1);
    if (last) last.endTick = this.engine.world.tick;
    return { format: 1, game: game.name, version, tickRate: game.tickRate ?? 30, savedAt: new Date().toISOString(), reason: this.broken ? `${reason} (incomplete: ${this.broken})` : reason, segments: structuredClone(this.segments) };
  }
}

function structuredCloneSafe(value: unknown[], onError: () => void): unknown[] {
  try { return structuredClone(value); } catch { onError(); return []; }
}

export interface ReplayResult<W> {
  world: W;
  engine: Engine<W & BaseWorld, any>;
  ticks: number;
  /** Checks that matched the recording. */
  verified: number;
  /** The first check that did not match (the simulation is not deterministic, or the code changed). */
  diverged?: { tick: number; expected: string; actual: string };
}
