import { createRegistry } from '@gaime/core';
import type { Feature, Kinds } from '../shared/types';

// Every src/features/<id>/server.ts is picked up automatically.
const modules = import.meta.glob<{ default: Feature }>('../features/*/server.ts', { eager: true });

export const registry = createRegistry<Kinds>(modules, {
  kinds: ['pickups'],
  validate: {
    pickups(def) {
      if (!Number.isFinite(def.value)) throw new Error(`pickups/${def.id}: "value" must be a number.`);
      if (!(def.weight >= 0)) throw new Error(`pickups/${def.id}: "weight" must be ≥ 0.`);
    },
  },
});

export type BlankRegistry = typeof registry;
