import { createRegistry } from '@gaime/core';
import type { Feature, Kinds } from '../shared/types';

// Every src/features/<id>/server.ts is picked up automatically.
const modules = import.meta.glob<{ default: Feature }>('../features/*/server.ts', { eager: true });

export const registry = createRegistry<Kinds>(modules, {
  kinds: ['powerups'],
  validate: {
    powerups(def) {
      if (!(def.weight >= 0)) throw new Error(`powerups/${def.id}: "weight" must be ≥ 0.`);
      if (!(def.duration > 0)) throw new Error(`powerups/${def.id}: "duration" must be a positive number of seconds.`);
    },
  },
});

export type BumperRegistry = typeof registry;
