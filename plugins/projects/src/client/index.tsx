/**
 * Browser half of dish-projects.
 *
 * For now it mounts the remote and nothing else: **Settings → Projects** (the section, the list and the form) is the next
 * task's, and it replaces this file. The controller (`controller.ts`) and the remote's descriptors (`remote.ts`) are what that
 * page is built on.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { projectsRemote } from './remote.ts'

export const inject = ['remote']

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await ctx.remote.$mount(projectsRemote)
}
