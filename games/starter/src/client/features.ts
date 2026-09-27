import { createFeatureModules } from '@gaime/core/client';
import { ModelLibrary, type ModelFactory } from '@gaime/core/three';

/** Default export of an optional `src/features/<id>/client.ts`. */
export interface ClientFeature {
  /** Custom shapes: `visual.shape` name → factory building a Three.js object ~1 unit tall. */
  models?: Record<string, ModelFactory>;
}

const modules = import.meta.glob<{ default: ClientFeature }>('../features/*/client.ts', { eager: true });

export function createModels() {
  const library = new ModelLibrary();
  for (const feature of createFeatureModules(modules)) {
    for (const [shape, factory] of Object.entries(feature.models ?? {})) library.register(shape, factory);
  }
  return library;
}
