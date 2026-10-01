/** The only failure codes the config store throws on purpose. */
export type ErrorCode =
  | 'CONFLICT'
  | 'INVALID'
  | 'UNOWNED'
  | 'FORBIDDEN'
  | 'SECRET'
  | 'TOO_LARGE'
  | 'LOCKED'
  | 'STALE'
  | 'NOT_FOUND'

/** A refusal the caller can act on, tagged with a stable `code`. */
export class ConfigStoreError extends Error {
  code: ErrorCode

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ConfigStoreError'
    this.code = code
  }
}
