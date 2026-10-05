import { secretKind } from '../secrets.ts'
import { StoreError } from './errors.ts'

// The patterns, and `secretKind`, live in `secrets.ts`: dish-judge masks with the same ones. They are re-exported here
// because the rest of this store (and dish-config's tests) import `secretKind` from this file.
export { secretKind }

/** `path` as it's safe to put in a one-line message: a path with control characters can't forge log lines. */
function shown(path: string): string {
  return /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path
}

/**
 * Refuse a document that is too big or looks like it holds a credential.
 * Everything in the store is pushed to GitHub, path included (it goes into
 * the tree and the commit subject), so both the path and the text are scanned,
 * and this runs before anything is written.
 *
 * The messages name the kind of secret and, when the path is clean, the path,
 * and nothing else: they end up in logs, tool results and agent transcripts, so
 * they never carry the matched text or anything around it. A path that holds a
 * secret is not shown at all.
 *
 * Checks run in this order: the path (`SECRET`), the size (`TOO_LARGE`, so the
 * scan never reads an oversized document), then the text (`SECRET`).
 * @param maxBytes - the most `text` may take as UTF-8.
 * @throws a plain `Error` if `maxBytes` is not a number that is zero or more.
 */
export function checkContent(path: string, text: string, maxBytes: number): void {
  // `!(x >= 0)` rather than `x < 0`: NaN must not turn the size cap off.
  if (!(maxBytes >= 0)) throw new Error(`maxBytes must be zero or more, got ${String(maxBytes)}`)
  const inPath = secretKind(path)
  if (inPath !== undefined) throw new StoreError('SECRET', `the document path looks like ${inPath}`)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxBytes) {
    throw new StoreError('TOO_LARGE', `${shown(path)}: ${bytes} bytes is over the ${maxBytes}-byte limit`)
  }
  const inText = secretKind(text)
  if (inText !== undefined) throw new StoreError('SECRET', `${shown(path)}: looks like ${inText}`)
}
