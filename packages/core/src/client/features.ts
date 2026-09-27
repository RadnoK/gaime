/**
 * Optional `src/features/<id>/client.ts` modules: custom 3D models, sounds or HUD
 * bits that belong to one feature. The game decides which fields it understands.
 */
export type ClientFeature = object;

/** `modules` is `import.meta.glob('../features/*\/client.ts', { eager: true })`. */
export function createFeatureModules<F extends object>(modules: Record<string, { default?: F }>) {
  return Object.keys(modules).sort().flatMap(file => {
    const feature = modules[file]?.default;
    if (!feature) { console.warn(`[gaime] ${file}: missing default export`); return []; }
    return [{ id: file.split('/').at(-2) ?? file, ...feature }];
  });
}
