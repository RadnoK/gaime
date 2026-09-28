/**
 * Gameplay kit: pure functions over plain data, usable on the server (simulation),
 * on the client (prediction, previews) and in tests. Nothing here touches the network.
 */
export { SpatialHash } from './spatial';
export { circlesOverlap, pointInRect, circleRect, rayCircle, raycast, rayEnd, separate, separateWith, clampToCircle, keepOutOfCircle, clampToRect, type Rect, type RayHit } from './collision';
export { launch, stepProjectiles, wasHit, ballisticAngle, type Projectile, type LaunchOptions, type StepProjectilesOptions } from './projectiles';
export { cooldown, every, schedule, due, status } from './timers';
export { createMatch, setReady, stepMatch, endMatch, toLobby, matchTimeLeft, type MatchState, type MatchPhase, type MatchRules, type MatchEvent } from './match';
export { createTurns, currentTurn, isTurnOf, turnTimeLeft, turnExpired, nextTurn, freezeTurn, resumeTurn, syncTurns, type TurnState } from './turns';
export { itemCount, hasItem, addItem, takeItem, transferItem, type Inventory } from './inventory';
export { range, int, chance, pick, weighted, shuffle, pointInRing, pointOnCircle } from './random';
export { balancedTeam, paletteColor, freeColor, TEAM_COLORS } from './teams';
export { addEffect, pruneEffects, type Effect, type EffectType } from './effects';
export { moveTopDown, type MoveInput } from './movement';
