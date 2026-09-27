/**
 * Counted items (ammo, potions, resources, cards in hand) as `Record<itemId, count>`
 * inside a player or entity — plain data, checkpoint friendly.
 */
export type Inventory = Record<string, number>;

export function itemCount(inventory: Inventory, id: string) {
  return inventory[id] ?? 0;
}

export function hasItem(inventory: Inventory, id: string, count = 1) {
  return (inventory[id] ?? 0) >= count;
}

/** Adds up to `max` (per item); returns how many were actually added (0 for count ≤ 0 or when already at max). */
export function addItem(inventory: Inventory, id: string, count = 1, max = Infinity) {
  const before = inventory[id] ?? 0;
  if (!(count > 0)) return 0;
  const after = Math.max(before, Math.min(max, before + count));
  if (after <= 0) delete inventory[id]; else inventory[id] = after;
  return after - before;
}

/** Removes `count` only if all of them are there; returns success. */
export function takeItem(inventory: Inventory, id: string, count = 1) {
  if (!hasItem(inventory, id, count)) return false;
  const left = (inventory[id] ?? 0) - count;
  if (left <= 0) delete inventory[id]; else inventory[id] = left;
  return true;
}

/** Move items between two inventories (trade, loot); returns how many moved. */
export function transferItem(from: Inventory, to: Inventory, id: string, count = 1, max = Infinity) {
  const available = Math.min(count, itemCount(from, id));
  const room = Math.max(0, max - itemCount(to, id));
  const moved = Math.min(available, room);
  if (moved > 0) { takeItem(from, id, moved); addItem(to, id, moved, max); }
  return moved;
}
