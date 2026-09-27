# AI skills

gaime is built to be developed with AI coding agents. Besides `AGENTS.md` (the rules every agent reads), the repository ships **skills**: step-by-step playbooks for recurring tasks, loaded by the agent when a task matches their description.

- Location: `.claude/skills/<name>/SKILL.md` (Claude Code). `.agents/skills` is a symlink to the same directory for other agents (Codex and others that read `.agents/`).
- Format: Markdown with frontmatter — `name` and a `description` that says **when** to use it. The agent sees all descriptions and opens the full file when one matches.
- Each game also has `games/<game>/AGENTS.md` (its module API and rules) and `games/<game>/docs/ADDING_FEATURES.md` (a complete module example). Skills tell the agent to read them first.

## The skills

| Skill | Use it for | Typical prompt |
| --- | --- | --- |
| `gaime-new-game` | a new game from a template, reshaped into a genre | "Make a co-op bomberman", "prototype a racing game" |
| `gaime-feature` | new content in an existing game as a module | "Add a boss that splits in two", "a teleport ability" |
| `gaime-module-kind` | a new extension point when content does not fit existing kinds | "Let people add maps", "add turrets as a module kind" |
| `gaime-mechanic` | core rules, world state, commands, rounds, scoring — safely for live saves | "Add a shop between waves", "friendly fire off" |
| `gaime-client` | HUD, menus, 3D scene, models, effects, camera, sound, controls | "Show a minimap", "use this glTF for the golem" |
| `gaime-bot` | AI players: opponents, teammates, filling seats, bot-vs-bot tests | "Add bots so I can practise alone" |
| `gaime-worker` | heavy computation off the game loop | "Enemies should pathfind around walls" |
| `gaime-networking` | what to send how, sync tuning, latency and load measurements | "It lags with 30 players" |
| `gaime-test` | logic tests, smoke, load, pre-push checks | "Test the new wave system" |
| `gaime-debug` | diagnosing a broken game locally or live | "The game is paused with ⚠", "my push is not live" |
| `gaime-deploy` | shipping, rollback, setting up a server | "Host this on my VPS", "roll back the last deploy" |
| `gaime-engine` | changing the framework itself | "The kit needs a hex grid", "fix reconnect" |

The skills reference each other (e.g. `gaime-feature` sends you to `gaime-module-kind` when the idea does not fit, and to `gaime-worker` for heavy logic) and the docs in `docs/` for API details.

## Using them

With Claude Code in this repository nothing needs to be configured: describe the task and the matching skill loads itself, or name it explicitly ("use the gaime-feature skill to add …"). Other agents: point them at `AGENTS.md`, which lists the skills, or paste the path of the skill file into the prompt.

Good prompts name **the game** and **the player-facing result**; the skill handles the how:

```text
In games/duel add a "bouncer" weapon: bounces twice before exploding, small damage. Use the gaime-feature skill.
```

```text
New game "hive" from blank: top-down co-op, players defend a hive from waves of wasps, pollen pickups
upgrade your stinger. Two module kinds: wasps and upgrades. Use the gaime-new-game skill.
```

## Writing a new skill

Add one when you notice the same multi-step explanation in several prompts:

1. `mkdir .claude/skills/gaime-<topic>` and write `SKILL.md`:

   ```markdown
   ---
   name: gaime-<topic>
   description: <What it does> — <scope>. Use when <the situations and phrases that should trigger it>.
   ---

   # <Title>

   ## 1. Orient      (files to read first)
   ## 2. Do          (the steps, with the rules that keep live games safe)
   ## 3. Verify      (exact commands)
   ```

2. The description decides when it is used: say concretely **when**, include the words users will say.
3. Keep it procedural and short (≤ 150 lines); link to `docs/` for reference material instead of copying it.
4. Everything in English. Add the skill to the table above and to `AGENTS.md`.
5. Try it: give an agent a real task in a fresh session and see whether it picks the skill and follows it.

Games can have their own skills too: `games/<game>/.claude/skills/…` is picked up when an agent works inside that directory — useful for a game's specific content workflows (e.g. "design a level for Hive").
