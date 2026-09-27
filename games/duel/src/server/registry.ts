import { createRegistry } from '@gaime/core';
import type { Feature, Kinds } from '../shared/types';

// Every src/features/<id>/server.ts is picked up automatically.
const modules = import.meta.glob<{ default: Feature }>('../features/*/server.ts', { eager: true });

export const registry = createRegistry<Kinds>(modules, {
  kinds: ['weapons'],
  validate: {
    weapons(def) {
      for (const key of ['speed', 'damage', 'radius'] as const) {
        if (!(Number.isFinite(def[key]) && def[key] > 0)) throw new Error(`weapons/${def.id}: "${key}" must be a positive number.`);
      }
      if (def.ammo !== undefined && !(Number.isInteger(def.ammo) && def.ammo > 0)) throw new Error(`weapons/${def.id}: "ammo" must be a positive integer.`);
      if (def.count !== undefined && !(Number.isInteger(def.count) && def.count >= 1 && def.count <= 12)) throw new Error(`weapons/${def.id}: "count" must be 1–12.`);
    },
  },
});

export type DuelRegistry = typeof registry;

/** The weapon every player starts with; it must exist. */
export const DEFAULT_WEAPON = 'shell';
