import { randomInt } from 'node:crypto';
import { matchMaker } from 'colyseus';
import type { RoomsConfig } from './game';
import { CREATE_KEY, createSecret, runtime } from './runtime';

/** Listing metadata every room keeps in the matchmaker driver (local memory or Redis). */
export interface RoomMetadata {
  /** Invite code of a private match. */
  code?: string;
  /** `ctx.lockRoom(true)`: no matchmaking into this room. */
  locked?: boolean;
  /** Human players in the world (online or not). */
  players?: number;
}

/** One room in `gaime rooms` / `/gaime/admin/rooms`. */
export interface RoomSummary {
  id: string;
  code?: string;
  /** Connections plus pending seat reservations (Colyseus). */
  clients: number;
  players: number;
  /** Locked by the game (`ctx.lockRoom`). */
  locked: boolean;
  /** Every seat taken. */
  full: boolean;
  private: boolean;
  createdAt: string;
  /** Colyseus process id (several processes with Redis). */
  process: string;
}

type Listing = Awaited<ReturnType<typeof matchMaker.query>>[number] & { metadata?: RoomMetadata };
type Reservation = Awaited<ReturnType<typeof matchMaker.reserveSeatFor>>;

/** Join options a client may pass through `POST /gaime/room` (everything else is dropped). */
export interface JoinRequest {
  ticket?: unknown;
  name?: unknown;
  protocol?: unknown;
  ephemeral?: unknown;
  /** Invite code of a private match. */
  code?: unknown;
  /** `private`: create an invite-only match. */
  create?: unknown;
  /** The room this browser played in: rejoin it if it still exists and takes them. */
  room?: unknown;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const TICKET = /^[A-Za-z0-9_-]{16,64}$/;
/** No I, L, O, 0, 1: easy to read out loud and to type. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
/** Attempts to find a seat before giving up (another client took the last one). */
const ATTEMPTS = 5;

export const normalizeCode = (raw: unknown) => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const randomCode = () => Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const maxRooms = () => Math.max(1, Number(process.env.GAIME_MAX_ROOMS) || 1000);

function matchesConfig(): Extract<RoomsConfig, { mode: 'matches' }> | undefined {
  const mode = runtime().mode;
  return mode.mode === 'matches' ? mode : undefined;
}

export function summary(listing: Listing): RoomSummary {
  const metadata = listing.metadata ?? {};
  return {
    id: listing.roomId,
    ...(metadata.code ? { code: metadata.code } : {}),
    clients: listing.clients,
    players: metadata.players ?? 0,
    locked: !!metadata.locked,
    full: listing.clients >= listing.maxClients,
    private: !!listing.private,
    createdAt: new Date(listing.createdAt ?? Date.now()).toISOString(),
    process: listing.processId,
  };
}

/**
 * Finds rooms for players and operators. `shared`: the one persistent room. `matches`: many rooms of
 * `size` seats; public matchmaking fills the fullest open room first, private rooms are found by code.
 * Seats are Colyseus seat reservations, so a room never takes more than `size` clients even when
 * requests race (and across processes with Redis). Public matchmaking is serialised per process;
 * behind the gateway every HTTP request reaches process 0.
 */
export function createMatchmaker(name: string) {
  let creatingShared: Promise<string> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };

  const all = async () => (await matchMaker.query({ name })) as Listing[];
  const byId = async (id: string) => (await matchMaker.getRoomById(id)) as Listing | undefined;
  const byCode = async (code: string) => code ? (await all()).find(room => room.metadata?.code === code) : undefined;

  async function sharedRoom(): Promise<string> {
    const rooms = await all();
    if (rooms[0]) return rooms[0].roomId;
    creatingShared ??= matchMaker.createRoom(name, { [CREATE_KEY]: createSecret() }).then(room => room.roomId).finally(() => { creatingShared = undefined; });
    return creatingShared;
  }

  async function create(options: Record<string, unknown> = {}): Promise<Listing> {
    if ((await all()).length >= maxRooms()) throw new HttpError(503, `Too many rooms (GAIME_MAX_ROOMS=${maxRooms()}). Try again soon.`);
    return (await matchMaker.createRoom(name, { ...options, [CREATE_KEY]: createSecret() })) as Listing;
  }

  async function createPrivate(): Promise<Listing> {
    if (matchesConfig()?.private === false) throw new HttpError(403, 'This game has no private matches.');
    const taken = new Set((await all()).map(room => room.metadata?.code));
    let code = randomCode();
    while (taken.has(code)) code = randomCode();
    return create({ private: true, code });
  }

  /** The public room a new player should go to: the fullest one with a free seat, then the oldest. */
  async function available(): Promise<Listing | undefined> {
    const rooms = (await matchMaker.query({ name, private: false, locked: false })) as Listing[];
    return rooms
      .filter(room => !room.metadata?.locked && room.clients < room.maxClients)
      .sort((a, b) => b.clients - a.clients || new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime())[0];
  }

  /** Whether a room already has a character for this browser ticket (returning players may enter locked rooms). */
  async function knows(room: Listing, ticket: string): Promise<boolean> {
    try { return !!(await matchMaker.remoteRoomCall(room.roomId, 'knows' as never, [ticket])); } catch { return false; }
  }

  async function reserve(room: Listing, options: Record<string, unknown>): Promise<Reservation | undefined> {
    try { return await matchMaker.reserveSeatFor(room, options); } catch { return undefined; }
  }

  const answer = (room: Listing, reservation?: Reservation) => ({
    roomId: room.roomId,
    ...(room.metadata?.code ? { code: room.metadata.code } : {}),
    mode: 'matches' as const,
    size: room.maxClients,
    ...(reservation ? { reservation } : {}),
  });

  return {
    sharedRoom,

    /** `GET /gaime/room[?code=|?create=private]`: a room id to `joinById` (tools, older clients). */
    async peek(query: { code?: unknown; create?: unknown }) {
      const matches = matchesConfig();
      if (!matches) return { roomId: await sharedRoom(), mode: 'shared' as const };
      if (query.create === 'private') return answer(await createPrivate());
      if (query.code !== undefined) {
        const room = await byCode(normalizeCode(query.code));
        if (!room) throw new HttpError(404, `No match with the code "${normalizeCode(query.code)}".`);
        return answer(room);
      }
      return serial(async () => answer((await available()) ?? (await create())));
    },

    /**
     * `POST /gaime/room`: find (or create) a room and reserve a seat for this ticket in one step.
     * The client consumes the reservation; nobody can take the seat in between.
     */
    async join(body: JoinRequest) {
      const ticket = body?.ticket;
      if (typeof ticket !== 'string' || !TICKET.test(ticket)) throw new HttpError(400, 'Missing player ticket.');
      const options: Record<string, unknown> = { ticket };
      if (typeof body.name === 'string') options.name = body.name.slice(0, 64);
      if (Number.isFinite(body.protocol)) options.protocol = body.protocol;
      if (body.ephemeral === true) options.ephemeral = true;

      const matches = matchesConfig();
      if (!matches) {
        const room = await byId(await sharedRoom());
        const reservation = room && await reserve(room, options);
        if (!room || !reservation) throw new HttpError(503, 'Game temporarily unavailable.');
        return { roomId: room.roomId, mode: 'shared' as const, reservation };
      }

      if (typeof body.room === 'string' && body.room) {
        const room = await byId(body.room);
        if (room && room.name === name && ((!room.private && !room.metadata?.locked) || await knows(room, ticket))) {
          const reservation = await reserve(room, options);
          if (reservation) return answer(room, reservation);
        }
      }
      if (body.code !== undefined && body.code !== '') {
        const code = normalizeCode(body.code);
        const room = await byCode(code);
        if (!room) throw new HttpError(404, `No match with the code "${code}".`);
        if (room.metadata?.locked && !await knows(room, ticket)) throw new HttpError(403, `The match ${code} has already started.`);
        const reservation = await reserve(room, options);
        if (!reservation) throw new HttpError(403, `The match ${code} is full.`);
        return answer(room, reservation);
      }
      if (body.create === 'private') {
        const room = await createPrivate();
        const reservation = await reserve(room, options);
        if (!reservation) throw new HttpError(503, 'Could not reserve a seat in the new match.');
        return answer(room, reservation);
      }
      return serial(async () => {
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
          const room = (await available()) ?? (await create());
          const reservation = await reserve(room, options);
          if (reservation) return answer(room, reservation);
        }
        throw new HttpError(503, 'No free seat right now. Try again.');
      });
    },

    /** Every room of this game (all processes). */
    async list(): Promise<RoomSummary[]> {
      return (await all()).map(summary).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    /** An admin action for one room: `target` is a room id or invite code; default the shared or the only room. */
    async admin(target: string | undefined, action: string, args: Record<string, unknown>) {
      let id: string;
      if (target) {
        const code = normalizeCode(target);
        const room = (await byId(target)) ?? (await byCode(code));
        if (!room || room.name !== name) throw new HttpError(404, `No room "${target}" (see gaime rooms).`);
        id = room.roomId;
      } else if (!matchesConfig()) {
        id = await sharedRoom();
      } else {
        const rooms = await all();
        if (!rooms.length) throw new HttpError(404, 'No match is running.');
        if (rooms.length > 1) throw new HttpError(400, `${rooms.length} rooms are running — choose one with --room <id|code> (gaime rooms).`);
        id = rooms[0].roomId;
      }
      // Express handlers outlive hot reloads: always ask the room that is live right now.
      const local = runtime().rooms[id];
      if (local) return await local.admin(action, args);
      return await matchMaker.remoteRoomCall(id, 'admin' as never, [action, args], 5000);
    },
  };
}
