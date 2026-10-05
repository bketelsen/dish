/**
 * What the address bar sends. The host decides what an address means and whether it opens (a scheme added, a refused place
 * worded as a notice); the bar only trims it and keeps it within what one item carries. Plain TypeScript, no DOM.
 */

import { URL_MAX } from '../protocol.ts'

/** The address to navigate to: `text` trimmed; undefined for nothing, or for more than `URL_MAX` characters. */
export function addressInput(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > URL_MAX) return undefined
  return trimmed
}
