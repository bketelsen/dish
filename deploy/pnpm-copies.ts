/**
 * Keeps dish's own installs apart from pnpm's store.
 *
 * pnpm hard-links a package's files from its store (`~/.local/share/pnpm/store`) into `node_modules` whenever it can,
 * as on the VM's ext4. A file in the checkout's `node_modules` and the same file in an agent's project under `~/work`
 * are then one inode. With DISH_SANDBOX_HOME on, the store and every project are writable by sandboxed commands, so an
 * agent that patched a file in its own `node_modules` would change the deployed dish too. So dish's own installs copy:
 * install.sh runs the checkout's install with `--package-import-method=clone-or-copy`, the profile's
 * `pnpm-workspace.yaml` says `packageImportMethod: clone-or-copy` (a reflink where the file system has them, as the
 * desktop's btrfs does, else a copy), and files that are links already are replaced by copies, since pnpm never imports
 * a package again when only that setting changes. Agents' own installs still link, in clones of dish too: the flag is
 * not in the checkout's `pnpm-workspace.yaml`, which every clone carries.
 *
 *   node deploy/pnpm-copies.ts [--workspace <pnpm-workspace.yaml>] [--unlink <dir>]...
 *
 * - `--workspace` sets `packageImportMethod: clone-or-copy` in that file, keeping the rest of it, and prints
 *   `workspace: updated` or `workspace: unchanged`. A missing file prints `workspace: missing` and is not made: dsh
 *   writes the profile's when it makes the profile, and a pnpm-workspace.yaml without its `packages` would change what
 *   pnpm makes of the directory.
 * - `--unlink` replaces every regular file under the directory that has more than one link with a copy of its own (the
 *   same content, mode and times), written beside it and renamed over it, so a reader sees one or the other. Links to
 *   directories are not followed. It prints `unlinked: <n> <dir>`. A file it can't replace is named on stderr, and the
 *   run still exits 0: the install goes on, with the warning in its output.
 *
 * Exits 1 when the workspace file can't be read, parsed or written, 2 for wrong arguments.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, constants, copyFileSync, lstatSync, readdirSync, renameSync, rmSync, utimesSync } from 'node:fs'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { isMap, isScalar, parseDocument } from 'yaml'

/** The setting, and the value dish's installs use. */
export const IMPORT_METHOD_KEY = 'packageImportMethod'
export const IMPORT_METHOD = 'clone-or-copy'

/**
 * Return a pnpm-workspace.yaml's text with `packageImportMethod: clone-or-copy`, or the text itself when it has it.
 * @throws When the text is not YAML, or not a mapping.
 */
export function withCopies(text: string): string {
  const doc = parseDocument(text)
  if (doc.errors[0] !== undefined) throw new Error(doc.errors[0].message.split('\n')[0]!)
  const map: unknown = doc.contents
  if (!isMap(map)) throw new Error('pnpm-workspace.yaml must be a mapping')
  const previous: unknown = map.get(IMPORT_METHOD_KEY, true)
  if (isScalar(previous) && previous.value === IMPORT_METHOD) return text
  if (isScalar(previous)) previous.value = IMPORT_METHOD
  else map.set(IMPORT_METHOD_KEY, doc.createNode(IMPORT_METHOD))
  return String(doc)
}

/** Set the import method in the file at `path`, keeping its mode. */
export async function updateWorkspace(path: string): Promise<'updated' | 'unchanged' | 'missing'> {
  let before: string
  try {
    before = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
  const after = withCopies(before)
  if (after === before) return 'unchanged'
  const { mode } = await stat(path)
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, after, { mode: mode & 0o777, flag: 'wx' })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  return 'updated'
}

export interface Unlinked {
  copied: number
  failed: Array<{ path: string, error: string }>
}

/** Replace `path`, a file with more than one link, by a copy of its own. */
function copyOver(path: string): void {
  const before = lstatSync(path)
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.copy`)
  try {
    // A reflink where the file system has them, else a plain copy: either way a new inode.
    copyFileSync(path, temp, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    chmodSync(temp, before.mode & 0o7777)
    utimesSync(temp, before.atime, before.mtime)
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** Replace every regular file under `dir` with more than one link by a copy of its own. A missing `dir` is nothing. */
export function unlinkFiles(dir: string): Unlinked {
  const result: Unlinked = { copied: 0, failed: [] }
  const pending = [dir]
  while (pending.length > 0) {
    const current = pending.pop()!
    let names: string[]
    try {
      names = readdirSync(current)
    } catch (error) {
      if (current === dir && (error as NodeJS.ErrnoException).code === 'ENOENT') return result
      result.failed.push({ path: current, error: (error as Error).message })
      continue
    }
    for (const name of names) {
      const path = join(current, name)
      let entry
      try {
        entry = lstatSync(path)
      } catch (error) {
        // Gone since the readdir (pnpm at work in the profile, say): nothing to copy.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        result.failed.push({ path, error: (error as Error).message })
        continue
      }
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.isFile() && entry.nlink > 1) {
        try {
          copyOver(path)
          result.copied += 1
        } catch (error) {
          result.failed.push({ path, error: (error as Error).message })
        }
      }
    }
  }
  return result
}

const USAGE = 'usage: node deploy/pnpm-copies.ts [--workspace <pnpm-workspace.yaml>] [--unlink <dir>]...'

/** The CLI. Returns the exit code: 0 done (failures to copy are warnings), 1 the workspace file failed, 2 usage. */
export async function main(argv: string[]): Promise<number> {
  let values
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      options: { workspace: { type: 'string' }, unlink: { type: 'string', multiple: true } },
    }))
  } catch (error) {
    console.error(`pnpm-copies.ts: ${(error as Error).message}\n${USAGE}`)
    return 2
  }
  if (values.workspace === undefined && values.unlink === undefined) {
    console.error(`pnpm-copies.ts: nothing to do\n${USAGE}`)
    return 2
  }
  if (values.workspace !== undefined) {
    try {
      console.log(`workspace: ${await updateWorkspace(values.workspace)}`)
    } catch (error) {
      console.error(`pnpm-copies.ts: ${values.workspace}: ${(error as Error).message}`)
      return 1
    }
  }
  for (const dir of values.unlink ?? []) {
    const { copied, failed } = unlinkFiles(dir)
    console.log(`unlinked: ${copied} ${dir}`)
    if (failed.length > 0) {
      console.error(`pnpm-copies.ts: ${failed.length} files under ${dir} are still links into pnpm's store, such as ${failed[0]!.path}: ${failed[0]!.error}`)
    }
  }
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
