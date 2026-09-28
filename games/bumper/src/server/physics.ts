import { createPhysics } from '@gaime/physics';
import type { World } from '../shared/types';
import { RULES } from '../shared/rules';

/**
 * Discs are Rapier bodies (`@gaime/physics`). The world keeps x/z/vx/vz/angle/spin as plain JSON;
 * the Rapier world is rebuilt from it after a hot reload. Server only — never import from the client.
 */
export const physics = createPhysics<World>({
  bodies: {
    players: {
      shape: { circle: RULES.radius },
      // `mass` is refreshed from the `push.mass` modifiers every tick (the `mass` system).
      density: player => player.mass,
      restitution: RULES.restitution,
      friction: 0.1,
      linearDamping: RULES.damping,
      angularDamping: 0.5,
      include: player => player.alive,
    },
  },
  contacts: true,
  // Two Rapier steps per 30 Hz tick: fast discs bounce cleanly.
  substeps: 2,
});
