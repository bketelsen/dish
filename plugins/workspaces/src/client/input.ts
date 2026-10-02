/**
 * What the person types into the card, checked before it is sent to dsh, and the way a failure's text is cleaned of it
 * afterwards. Plain TypeScript with no DOM or React in it, so `node --test` can load it.
 *
 * Every message here is fixed text: none quotes what was typed, so a refusal can't put a key on the screen.
 * @module dish-workspaces/client/input
 */

/** The longest App ID taken: GitHub's are a few digits, and nothing near this long is one. */
export const APP_ID_MAX = 20

/** The longest key taken: a 4096-bit RSA key is about 3.2 KB as a PEM. */
export const KEY_MAX = 16 * 1024

export type Prepared = { ok: true, value: string } | { ok: false, problem: string }

/**
 * The App ID as it is sent: the digits, with the spaces around them taken off. GitHub's page shows it as a number
 * ("App ID: 1234567"). (The App's *client* ID, `Iv1.…`, is a different thing and is not taken.)
 */
export function appIdValue(text: string): Prepared {
  const value = text.trim()
  if (value === '') return { ok: false, problem: 'Enter the App ID first.' }
  if (value.length > APP_ID_MAX || !/^[0-9]+$/.test(value)) {
    return { ok: false, problem: 'The App ID is a number: digits only, as GitHub shows it at the top of the App\'s settings page.' }
  }
  return { ok: true, value }
}

/**
 * The private key as it is sent: the PEM with its line breaks, which are what make it a PEM. Line endings are made `\n`,
 * the blank space around the key is taken off and one final line break is left, as the file GitHub gives has. It has to start
 * with `-----BEGIN`, say `PRIVATE KEY-----`, end with an `-----END` line and have its lines, so a key pasted with the breaks
 * lost (all on one line) is refused here and not at the first test.
 */
export function privateKeyValue(text: string): Prepared {
  const value = text.replace(/\r\n?/g, '\n').trim()
  if (value === '') return { ok: false, problem: 'Paste the private key first.' }
  if (value.length > KEY_MAX) return { ok: false, problem: 'That is too long to be a private key.' }
  const lines = value.split('\n')
  if (!value.startsWith('-----BEGIN') || !lines[0]!.includes('PRIVATE KEY-----')) {
    return { ok: false, problem: 'That is not a private key. Paste the whole .pem file GitHub gave you: it starts with a line "-----BEGIN RSA PRIVATE KEY-----".' }
  }
  if (lines.length < 3) {
    return { ok: false, problem: 'The private key has lost its line breaks. Paste the .pem file\'s contents as they are, line by line.' }
  }
  if (!lines[lines.length - 1]!.startsWith('-----END')) {
    return { ok: false, problem: 'The private key is cut short: it should end with an "-----END … PRIVATE KEY-----" line.' }
  }
  return { ok: true, value: `${value}\n` }
}

/**
 * A function that takes `secret` out of a text, in every form it can take there (as it is, JSON-escaped, URL-encoded), and
 * each long line of it too: for what a failure says, which must not carry a key back to the screen. A value too short to tell
 * from other text is left, as it would turn every letter that is the same into noise.
 */
export function hiding(secret: string): (text: string) => string {
  const pieces = new Set<string>()
  const add = (value: string, shortest: number): void => {
    if (value.length < shortest) return
    for (const form of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) pieces.add(form)
  }
  add(secret.trim(), 4)
  for (const line of secret.split(/\r?\n/)) add(line.trim(), 16)
  // The longest first: the whole before its lines.
  const ordered = [...pieces].sort((a, b) => b.length - a.length)
  return text => ordered.reduce((hidden, piece) => hidden.split(piece).join('…'), text)
}
