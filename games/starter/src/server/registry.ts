import { createRegistry } from '@gaime/core';
import type { Kinds } from '../shared/types';

// Every src/features/<id>/server.ts is picked up automatically — no central list to edit.
const modules = import.meta.glob<{ default: import('../shared/types').Feature }>('../features/*/server.ts', { eager: true });

export const registry = createRegistry<Kinds>(modules, {
  kinds: ['enemies', 'abilities', 'waves'],
  validate: {
    enemies(def) {
      for (const key of ['hp', 'speed', 'radius', 'damage', 'reward'] as const) {
        if (!Number.isFinite(def[key]) || def[key] < 0) throw new Error(`enemies/${def.id}: "${key}" must be a non-negative number.`);
      }
      if (def.hp <= 0 || def.radius <= 0) throw new Error(`enemies/${def.id}: hp and radius must be positive.`);
      // Crowd separation searches neighbours this far (simulation.ts MAX_ENEMY_RADIUS).
      if (def.radius > 2.5) throw new Error(`enemies/${def.id}: radius must be at most 2.5.`);
      if (!def.visual?.shape) throw new Error(`enemies/${def.id}: missing visual.shape.`);
    },
    abilities(def) {
      if (!(def.cooldown >= 0)) throw new Error(`abilities/${def.id}: cooldown must be non-negative.`);
      if (typeof def.cast !== 'function') throw new Error(`abilities/${def.id}: missing cast function.`);
    },
    waves(def) {
      if (typeof def.start !== 'function') throw new Error(`waves/${def.id}: missing start function.`);
    },
  },
});

export type StarterRegistry = typeof registry;
