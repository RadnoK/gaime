import * as THREE from 'three';

/**
 * Keeps one Object3D per entity id in sync with a dictionary from the world:
 * creates new ones, rebuilds when `key(entity)` changes (e.g. its visual), removes the rest.
 */
export class EntityLayer<T extends { id: string }> {
  readonly group = new THREE.Group();
  readonly items = new Map<string, { object: THREE.Object3D; key: string; entity: T }>();

  constructor(
    parent: THREE.Object3D,
    private readonly create: (entity: T) => THREE.Object3D,
    private readonly key: (entity: T) => string = () => '',
  ) {
    parent.add(this.group);
  }

  sync(entities: Iterable<T>) {
    const seen = new Set<string>();
    for (const entity of entities) {
      seen.add(entity.id);
      const key = this.key(entity);
      const item = this.items.get(entity.id);
      if (item && item.key === key) { item.entity = entity; continue; }
      if (item) this.drop(entity.id);
      const object = this.create(entity);
      this.group.add(object);
      this.items.set(entity.id, { object, key, entity });
    }
    for (const id of [...this.items.keys()]) if (!seen.has(id)) this.drop(id);
  }

  forEach(callback: (object: THREE.Object3D, entity: T) => void) {
    for (const { object, entity } of this.items.values()) callback(object, entity);
  }

  private drop(id: string) {
    const item = this.items.get(id);
    if (!item) return;
    this.group.remove(item.object);
    disposeOwned(item.object);
    this.items.delete(id);
  }

  dispose() {
    for (const id of [...this.items.keys()]) this.drop(id);
    this.group.removeFromParent();
  }
}

/** Dispose materials/textures; geometry only when it is not shared by `ModelLibrary`. */
export function disposeOwned(root: THREE.Object3D) {
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry && !mesh.userData.sharedGeometry) mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
      material.dispose();
    }
  });
}
