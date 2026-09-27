/**
 * Wire protocol between GameClient and the game room (MessagePack over WebSocket, via Colyseus).
 * Full description with examples: docs/PROTOCOL.md.
 *
 * client → server
 *   hello    (no payload)                         ask for a full snapshot (join, reconnect, desync)
 *   input    <game input>                         continuous state, throttled, lease ~400 ms
 *   command  { type, ... }                        discrete action; `$`-prefixed types are engine commands
 *   request  { id, name, payload }                RPC; answered with `response`
 *
 * server → client
 *   welcome  { id, game, version, protocol, revision, host, world }   full snapshot
 *   patch    { base, revision, values?, removed?, entities?, streams? } delta against `base`
 *   event    { name, data }                       one-off, not stored in the world (sounds, shakes, toasts)
 *   response { id, ok, result? , error? }
 *   notice   string                               private toast
 *   removed                                       you were removed from the game (close 4102 follows)
 */
export const PROTOCOL_VERSION = 2;

export interface RequestMessage {
  id: number;
  name: string;
  payload?: unknown;
}

export interface ResponseMessage {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface EventMessage {
  name: string;
  data?: unknown;
}

/** Engine commands start with `$`; games must not use that prefix. */
export type EngineCommand =
  | { type: '$chat'; text: string }
  | { type: '$pause' }
  | { type: '$resume' };
