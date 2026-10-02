/**
 * Registering a directory with dsh's workspace registry (`ctx.workspaceRegistry`, from `@deepseek-ai/dsh-workspace`),
 * which only dsh-web-app mounts. Used for each ready project's clone and for the scratch workspace.
 *
 * What the registry does (read from dsh 0.2.0-rc.2 and run against it, see the spec's Checks): `create(path, title?)`
 * canonicalises the path with `realpath` and rejects a relative, missing or non-directory one; for a path it already
 * has it returns that record and leaves the title alone; a deleted registration leaves nothing behind, so re-adding the
 * path makes a new record. "Registered once" is therefore dish's own record (scratch.ts), not the registry's.
 *
 * @module dish-workspaces/registry
 */

import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

/** The part of dsh's registry dish uses, so a caller says what it needs and a test can stand in for it. */
export type WorkspaceRegistryLike = Pick<WorkspaceRegistry, 'create' | 'resolveByPath' | 'get' | 'list'>

/**
 * `create(path, title)`. When dsh made a new record and its title isn't `title` (a dsh that dropped the parameter, which
 * its README says may happen), `setTitle` on it. A record that was there keeps its title: whatever it is called now is
 * the user's.
 *
 * `created` says whether this call made the record, and `title` is the title the record has afterwards. A title is
 * cosmetic, so a `setTitle` that fails doesn't undo the registration (the directory is registered either way, and the
 * next call would find the record and leave its title alone): the result's `title` tells the caller what dsh holds.
 *
 * Rejects as the registry does, for a relative, missing or non-directory `path`.
 *
 * A known limit: `created` is decided by looking before creating, so of two calls for one new path made at the same
 * time, both may say `created`. The ids are the same and there is one record. Callers that care (the scratch workspace,
 * a project's onboarding) run one at a time.
 */
export async function registerWorkspace(
  registry: WorkspaceRegistryLike,
  path: string,
  title: string,
): Promise<{ id: string, created: boolean, title: string }> {
  // create() hands back an existing record without saying so. resolveByPath canonicalises the same way and rejects the
  // same paths, so a bad path fails here with dsh's own error before anything is made.
  const existing = await registry.resolveByPath(path)
  const workspace = await registry.create(path, title)
  const created = existing === undefined
  if (created && workspace.title !== title) {
    try {
      await workspace.setTitle(title)
    } catch {
      // Cosmetic: see above. The result says what the title is.
    }
  }
  return { id: workspace.id, created, title: workspace.title }
}
