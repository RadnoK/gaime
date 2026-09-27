import { wrapAngle } from '../shared/math';

/**
 * Maps the server's `world.time` onto the local clock so remote entities can be
 * rendered slightly in the past (smooth even with 15 Hz patches and jitter).
 */
export class ServerClock {
  private offset?: number;

  /** Call on every received world. */
  sync(serverTime: number, localMs = performance.now()) {
    const offset = localMs / 1000 - serverTime;
    // The fastest delivery is the best estimate; drift up slowly after pauses or lag spikes.
    if (this.offset === undefined || offset < this.offset || Math.abs(offset - this.offset) > 1) this.offset = offset;
    else this.offset += (offset - this.offset) * 0.02;
  }

  /** Estimated current server time, minus `delay` seconds of interpolation buffer. */
  now(delay = 0.1, localMs = performance.now()) {
    return this.offset === undefined ? 0 : localMs / 1000 - this.offset - delay;
  }
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
