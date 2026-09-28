import { wrapAngle } from '../shared/math';

/** Samples kept for the patch interval and delivery jitter estimates. */
const WINDOW = 40;
/** Extra buffer on top of one patch interval and the observed jitter, in seconds. */
const MARGIN = 0.012;
/** Bounds of the automatic interpolation delay, in seconds. */
const MIN_DELAY = 0.025;
const MAX_DELAY = 0.25;

/**
 * Maps the server's `world.time` onto the local clock so remote entities can be
 * rendered slightly in the past. `now()` without an argument uses the smallest delay
 * that still keeps a patch ahead of the render time: one publish interval plus the
 * jitter measured on this connection (~80 ms at 15 Hz on a good network, ~35 ms at 60 Hz).
 */
export class ServerClock {
  private offset?: number;
  private lastTime?: number;
  private readonly intervals: number[] = [];
  private readonly lateness: number[] = [];
  private current = 0.1;

  /** Call on every received world. */
  sync(serverTime: number, localMs = performance.now()) {
    const offset = localMs / 1000 - serverTime;
    // The fastest delivery is the best estimate; drift up slowly after pauses or lag spikes.
    if (this.offset === undefined || offset < this.offset || Math.abs(offset - this.offset) > 1) this.offset = offset;
    else this.offset += (offset - this.offset) * 0.02;
    // Only new server time says anything about the cadence (paused worlds and repeated worlds do not).
    if (this.lastTime !== undefined && serverTime > this.lastTime) {
      push(this.intervals, serverTime - this.lastTime);
      push(this.lateness, offset - this.offset);
      this.adapt();
    }
    this.lastTime = serverTime;
  }

  /**
   * Estimated current server time minus the interpolation delay: `delay` seconds when
   * given, otherwise the automatic delay (see `delay`).
   */
  now(delay: number = this.current, localMs = performance.now()) {
    return this.offset === undefined ? 0 : localMs / 1000 - this.offset - delay;
  }

  /** The automatic interpolation delay in seconds (0.1 until a few patches arrived). */
  get delay() { return this.current; }

  private adapt() {
    if (this.intervals.length < 4) return;
    // The longest recent gap between patches (extra publishes after commands are shorter)
    // plus a high percentile of how late patches arrive compared to the fastest one.
    const interval = Math.max(...this.intervals);
    const late = [...this.lateness].sort((a, b) => a - b)[Math.floor(this.lateness.length * 0.9)] ?? 0;
    const target = Math.min(MAX_DELAY, Math.max(MIN_DELAY, interval + Math.max(0, late) + MARGIN));
    // Grow quickly (running out of samples stutters), shrink slowly (a jump back in time is visible).
    this.current += (target - this.current) * (target > this.current ? 0.3 : 0.05);
  }
}

function push(list: number[], value: number) {
  list.push(value);
  if (list.length > WINDOW) list.shift();
}

type Sample = { t: number; v: Record<string, number> };

/** Per-entity sample buffers. Fields listed in `angles` interpolate along the shortest arc. */
export class Interpolator {
  private readonly tracks = new Map<string, Sample[]>();
  constructor(private readonly angles: string[] = ['angle'], private readonly keep = 12) {}

  push(id: string, t: number, values: Record<string, number>) {
    let track = this.tracks.get(id);
    if (!track) this.tracks.set(id, track = []);
    const last = track.at(-1);
    if (last && t === last.t) { last.v = values; return; }
    // Time went backwards (world reset): start over.
    if (last && t < last.t) track.length = 0;
    track.push({ t, v: values });
    if (track.length > this.keep) track.splice(0, track.length - this.keep);
  }

  sample(id: string, t: number): Record<string, number> | undefined {
    const track = this.tracks.get(id);
    if (!track?.length) return undefined;
    if (t <= track[0].t) return track[0].v;
    const last = track.at(-1)!;
    if (t >= last.t) return last.v;
    for (let i = track.length - 1; i > 0; i--) {
      const a = track[i - 1];
      const b = track[i];
      if (t < a.t) continue;
      const k = (t - a.t) / (b.t - a.t || 1);
      const out: Record<string, number> = {};
      for (const key of Object.keys(b.v)) {
        const from = a.v[key] ?? b.v[key];
        out[key] = this.angles.includes(key) ? from + wrapAngle(b.v[key] - from) * k : from + (b.v[key] - from) * k;
      }
      return out;
    }
    return last.v;
  }

  /** Forget entities that no longer exist. */
  retain(ids: Iterable<string>) {
    const keep = new Set(ids);
    for (const id of this.tracks.keys()) if (!keep.has(id)) this.tracks.delete(id);
  }
}
