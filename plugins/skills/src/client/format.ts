/**
 * The page's wording for commit ids. Plain TypeScript with no DOM or React in it, so `node --test` can load it. The rest of
 * the page's wording (authors, times, commit subjects) is the History page's own (`dish-config/src/client/format.ts`),
 * kept in step by hand.
 * @module dish-skills/client/format
 */

/** The short form of a commit id: its first 7 characters. */
export function shortId(id: string): string {
  return id.slice(0, 7)
}
