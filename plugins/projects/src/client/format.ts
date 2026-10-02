/**
 * The page's wording for times, status and commit ids. Plain TypeScript with no DOM or React in it, so `node --test` can
 * load it. (Settings → Projects' components add to this.)
 * @module dish-projects/client/format
 */

/** The short form of a commit id: its first 7 characters. */
export function shortId(id: string): string {
  return id.slice(0, 7)
}
