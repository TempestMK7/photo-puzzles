/**
 * Another photo for the next puzzle: not the one just played, and one that has not been solved yet with these settings if there is one, else any other. `rand` gives a
 * number in [0, 1). Undefined when there is no other photo.
 */
export function pickAnother<T extends { id: string }>(entries: readonly T[], currentId: string, solved: (e: T) => boolean, rand: () => number = Math.random): T | undefined {
  const others = entries.filter((e) => e.id !== currentId);
  const fresh = others.filter((e) => !solved(e));
  const pool = fresh.length ? fresh : others;
  return pool[Math.floor(rand() * pool.length)];
}
