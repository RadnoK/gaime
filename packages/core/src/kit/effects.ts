/**
 * Short-lived visual events (tracers, explosions, floating text) kept in a World
 * array and synchronised as a stream (`network.streams: ['effects']`). Immutable
 * once emitted: the client animates them by age (`renderTime - effect.time`).
 * `EffectsLayer` in `@gaime/core/three` draws the built-in types.
 */
export type EffectType = 'tracer' | 'pulse' | 'hit' | 'spawn' | 'text' | 'explosion' | (string & {});

export interface Effect {
  id: number;
  type: EffectType;
  time: number;
  x: number;
  z: number;
  /** Height above the ground (default depends on the type). */
  y?: number;
  /** End point for tracers / beams. */
  x2?: number;
  z2?: number;
  radius?: number;
  color?: string;
  text?: string;
}

/** Append an effect; `id` from `ctx.nextId()`. */
export function addEffect(list: Effect[], id: number, type: EffectType, time: number, at: { x: number; z: number }, options: Partial<Omit<Effect, 'id' | 'type' | 'time' | 'x' | 'z'>> = {}): Effect {
  const effect: Effect = { id, type, time, x: at.x, z: at.z, ...options };
  list.push(effect);
  return effect;
}

/** Drop effects older than `life` seconds (call once per tick). Returns the kept list. */
export function pruneEffects(list: Effect[], time: number, life = 1.5): Effect[] {
  return list.filter(effect => time - effect.time < life);
}
