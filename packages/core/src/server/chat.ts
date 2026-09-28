import type { BaseWorld, PlayerOf } from '../shared/types';
import { pushFeed } from '../shared/world';
import type { ChatCommand, GameContext, GameDefinition } from './game';

export interface ChatHost<W extends BaseWorld> {
  ctx: GameContext<W>;
  /** The game defines a bot brain: enable /bot. */
  bots?: boolean;
  rename(playerId: string, name: string): string | void;
  pause(playerId: string, paused: boolean): string | void;
  /** No flood limit (replays run faster than real time). */
  unlimited?: boolean;
}

const MAX_LENGTH = 200;
const MIN_INTERVAL_MS = 350;
/** Short bursts are fine, a flood is not: 8 messages per 10 s window. */
const BURST = 8;
const WINDOW_MS = 10_000;

/** Built-in slash commands. Games add their own via `GameDefinition.chat.commands`. */
function builtins<W extends BaseWorld>(host: ChatHost<W>): Record<string, ChatCommand<W>> {
  return {
    help: {
      description: 'list commands',
      run: (_world, _id, _args) => undefined,
    },
    w: {
      description: 'private message', usage: '<nick> <text>',
      run(world, id, args, ctx) {
        const [name, ...rest] = args.split(' ');
        const target = name ? ctx.findPlayer(name) : undefined;
        const text = rest.join(' ').trim();
        if (!target || !text) return 'Usage: /w <nick> <text>';
        if (!target.online) return `${target.name} is offline.`;
        const from = world.players[id];
        ctx.notify(target.id, `✉ ${from.name}: ${text}`);
        return `✉ to ${target.name}: ${text}`;
      },
    },
    me: {
      description: 'third-person action', usage: '<action>',
      run(world, id, args) {
        if (!args.trim()) return 'Usage: /me <action>';
        pushFeed(world, args.trim().slice(0, MAX_LENGTH), id, 'me');
      },
    },
    nick: {
      description: 'change your nickname', usage: '<new nick>',
      run: (_world, id, args) => host.rename(id, args),
    },
    who: {
      description: 'who is playing',
      run(world) {
        const online = Object.values(world.players).filter(p => p.online);
        return `Online (${online.length}): ${online.map(p => `${world.hostId === p.id ? '👑' : ''}${p.name}`).join(', ') || '—'}`;
      },
    },
    kick: {
      description: 'remove a player from the game', usage: '<nick>', host: true,
      run(world, id, args, ctx) {
        const target = ctx.findPlayer(args);
        if (!target) return `No player named "${args}".`;
        if (target.id === id) return 'You cannot kick yourself.';
        ctx.removePlayer(target.id);
        ctx.log(`${world.players[id]?.name ?? 'The host'} removed ${target.name} from the game.`);
      },
    },
    pause: { description: 'pause the game', host: true, run: (_w, id) => host.pause(id, true) },
    resume: { description: 'resume the game', host: true, run: (_w, id) => host.pause(id, false) },
    ...(host.bots ? {
      bot: {
        description: 'add a bot, or remove all bots', usage: '[name] | remove', host: true,
        run(world, _id, args, ctx) {
          if (args.trim() === 'remove') {
            const bots = Object.values(world.players).filter(p => ctx.isBot(p.id));
            for (const bot of bots) ctx.removePlayer(bot.id);
            return bots.length ? `Removed ${bots.length} bot(s).` : 'There are no bots.';
          }
          ctx.addBot(args.trim().slice(0, 24) || undefined);
        },
      } satisfies ChatCommand<W>,
    } : {}),
  };
}

/**
 * Handles one `$chat` command: rate limit, length, filter, slash commands.
 * Returns a private answer for the author, if any.
 */
export function createChat<W extends BaseWorld>(game: GameDefinition<W, unknown>, host: ChatHost<W>) {
  const history: Record<string, number[]> = {};
  const commands = { ...builtins(host), ...game.chat?.commands };

  function help(world: W, id: string) {
    return Object.entries(commands)
      .filter(([, command]) => !command.host || world.hostId === id)
      .map(([name, command]) => `/${name}${command.usage ? ` ${command.usage}` : ''} — ${command.description}${command.host ? ' (host)' : ''}`)
      .join('\n');
  }

  return function chat(world: W, id: string, raw: unknown): string | void {
    const player = world.players[id] as PlayerOf<W> | undefined;
    if (!player || typeof raw !== 'string') return;
    let text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH);
    if (!text) return;
    if (!host.unlimited) {
      const now = Date.now();
      const recent = (history[id] ?? []).filter(at => now - at < WINDOW_MS);
      if (recent.length && now - recent[recent.length - 1] < MIN_INTERVAL_MS) return 'Slow down a little.';
      if (recent.length >= BURST) return 'Too many messages — wait a moment.';
      history[id] = [...recent, now];
    }

    if (text.startsWith('/')) {
      const [name, ...rest] = text.slice(1).split(' ');
      const command = commands[name.toLowerCase()];
      if (!command) return `Unknown command /${name}. Type /help.`;
      if (command.host && world.hostId !== id) return `Only the host (👑) can use /${name}.`;
      if (name.toLowerCase() === 'help') return help(world, id);
      return command.run(world, id, rest.join(' ').trim(), host.ctx);
    }
    if (game.chat?.filter) {
      const filtered = game.chat.filter(text, player);
      if (filtered === null) return;
      text = filtered.slice(0, MAX_LENGTH);
    }
    pushFeed(world, text, id, 'chat');
  };
}
