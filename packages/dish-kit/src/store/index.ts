/**
 * dish-kit/store — the versioned store, any plugin's to open: one bare git repository behind one queue and a process
 * lock, with namespaces, proposals and a push to a remote. dish-config's config store is one (`VersionedStore` with
 * its own `StoreNaming`); dish-memory's vault is another.
 *
 * Everything the store's modules export is here, the package-internal parts included: dish-config's shims re-export
 * them at their old paths.
 *
 * @module dish-kit/store
 */

export * from './errors.ts'
export * from './git.ts'
export * from './guard.ts'
export * from './identity.ts'
export * from './lock.ts'
export * from './namespaces.ts'
export * from './proposals.ts'
export * from './push.ts'
export * from './store.ts'
