import { pathProblem } from './git.ts'

/** A path prefix a plugin claims, with its own validation and the most an agent may do there. */
export interface NamespaceSpec {
  /** `prompts/` owns everything under that directory; anything else (`crew.yaml`) is that one path. */
  prefix: string
  /** The claiming plugin's name, for errors and the History page. */
  owner: string
  /** An error message for a document that isn't valid here, or `undefined` if it is. */
  validate(path: string, text: string): string | undefined
  /** The most an agent may do in this namespace. */
  agent: 'write' | 'propose' | 'none'
}

const AGENT_POLICIES: readonly string[] = ['write', 'propose', 'none']

/** Whether the claim `prefix` covers `path`: the subtree for `dir/`, otherwise exactly that path. */
function matches(prefix: string, path: string): boolean {
  return prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix
}

/** `prefix` without the trailing slash that marks a subtree. */
function bare(prefix: string): string {
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
}

/**
 * Whether two claims can't both hold. A tree has one thing at each path, so
 * `x/y` (a file) and `x/y/` (a directory) clash even though a document path
 * never matches both; so do `x/y` and anything under `x/y/`. Claims are
 * disjoint when neither is the other or one of its parent directories.
 */
function overlaps(a: string, b: string): boolean {
  const first = bare(a)
  const second = bare(b)
  return first === second || second.startsWith(`${first}/`) || first.startsWith(`${second}/`)
}

/**
 * Check a claim before it's accepted. A bad spec is a bug in the claiming
 * plugin, so it throws a plain `Error`, never a `StoreError`.
 */
function checkSpec(spec: NamespaceSpec): void {
  if (typeof spec !== 'object' || spec === null) throw new Error('namespace spec must be an object')
  if (typeof spec.prefix !== 'string') throw new Error('namespace prefix must be a string')
  // A trailing slash only marks a subtree; everything before it follows the same rules as a document path.
  const problem = pathProblem(bare(spec.prefix))
  if (problem !== undefined) throw new Error(`invalid namespace prefix ${JSON.stringify(spec.prefix)}: ${problem}`)
  if (typeof spec.owner !== 'string' || spec.owner === '') {
    throw new Error(`namespace ${JSON.stringify(spec.prefix)} needs a non-empty owner`)
  }
  if (!AGENT_POLICIES.includes(spec.agent)) {
    throw new Error(`namespace ${JSON.stringify(spec.prefix)} has agent policy ${JSON.stringify(spec.agent)}; expected one of ${AGENT_POLICIES.join(', ')}`)
  }
  if (typeof spec.validate !== 'function') throw new Error(`namespace ${JSON.stringify(spec.prefix)} needs a validate function`)
}

/** One live claim. Each `claim()` makes its own, so a disposer can only ever remove the claim it came from. */
interface Claim {
  spec: NamespaceSpec
}

/**
 * Who owns which paths. Claims are disjoint (see `overlaps`), so a path has at
 * most one owner. Releasing a claim only forgets the owner; the files stay.
 */
export class NamespaceRegistry {
  private claims: Claim[] = []

  /**
   * Claim `spec.prefix` for `spec.owner`.
   * @returns a disposer that releases this claim. It is safe to call more than
   *   once, and never touches a later claim on the same prefix.
   * @throws a plain `Error` if `spec` is malformed or overlaps a live claim.
   */
  claim(spec: NamespaceSpec): () => void {
    checkSpec(spec)
    for (const { spec: other } of this.claims) {
      if (overlaps(spec.prefix, other.prefix)) {
        throw new Error(
          `namespace ${JSON.stringify(spec.prefix)} (owner ${JSON.stringify(spec.owner)}) overlaps `
          + `${JSON.stringify(other.prefix)} (owner ${JSON.stringify(other.owner)})`)
      }
    }
    const claim: Claim = { spec }
    this.claims.push(claim)
    return () => {
      const index = this.claims.indexOf(claim)
      if (index !== -1) this.claims.splice(index, 1)
    }
  }

  /**
   * The namespace that owns the document at `path`, if any. A path that can't
   * be a document (`..` segments, a trailing slash, control characters, ...) is
   * never owned, however it starts.
   */
  ownerOf(path: string): NamespaceSpec | undefined {
    if (pathProblem(path) !== undefined) return undefined
    return this.claims.find(({ spec }) => matches(spec.prefix, path))?.spec
  }

  /** Every live claim, in the order they were made. */
  all(): NamespaceSpec[] {
    return this.claims.map(({ spec }) => spec)
  }
}
