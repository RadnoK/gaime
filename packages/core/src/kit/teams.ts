/** Team helpers: balanced assignment and colours. Teams are plain ids stored on players. */

export const TEAM_COLORS = ['#ff5977', '#59a8ff', '#7dff9b', '#ffd659', '#b481ff', '#59ffe0'];

/**
 * Team for a newcomer: the smallest team among `teams` (ties → first).
 * `current` = team of every existing player.
 */
export function balancedTeam(teams: readonly string[], current: Iterable<string | undefined>): string {
  const sizes = new Map(teams.map(team => [team, 0]));
  for (const team of current) if (team && sizes.has(team)) sizes.set(team, sizes.get(team)! + 1);
  return [...sizes.entries()].sort((a, b) => a[1] - b[1] || teams.indexOf(a[0]) - teams.indexOf(b[0]))[0][0];
}

/** Colour for the n-th player or team, cycling through a palette. */
export function paletteColor(index: number, palette: readonly string[] = TEAM_COLORS) {
  return palette[((index % palette.length) + palette.length) % palette.length];
}

/** First colour of `palette` not used yet, else a cycled one. */
export function freeColor(used: Iterable<string>, palette: readonly string[] = TEAM_COLORS) {
  const taken = new Set(used);
  return palette.find(color => !taken.has(color)) ?? paletteColor(taken.size, palette);
}
