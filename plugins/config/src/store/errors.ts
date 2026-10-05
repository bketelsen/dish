// The store's code is dish-kit's (`dish-kit/store`), and it throws `StoreError`s. This file keeps dish-config's own
// error class at its old path, for the plugins and tests that import it from here or from dish-config.
import { StoreError } from 'dish-kit/store'
import type { ErrorCode } from 'dish-kit/store'

export type { ErrorCode }

/**
 * A refusal the caller can act on, tagged with a stable `code`, under dish-config's name. One made here is named
 * `ConfigStoreError`; and every `StoreError` is an instance, so `instanceof ConfigStoreError` matches what the store throws.
 */
export class ConfigStoreError extends StoreError {
  constructor(code: ErrorCode, message?: string) {
    super(code, message)
    this.name = 'ConfigStoreError'
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof StoreError
  }
}
