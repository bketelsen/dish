/**
 * Browser-side helpers for hand-written Typert remote descriptors. dsh
 * generates these for in-tree packages, but the generator is not published.
 *
 * This module is bundled into browsers: it may import only types from
 * `@deepseek-ai/*` and nothing from `node:*`.
 */

import type {
  InvocationDescriptor, TypertCodec, TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'

/** A strict pass-through codec: the value is already plain JSON. */
export const jsonCodec: Extract<TypertCodec, { mode: 'strict' }> = {
  mode: 'strict',
  typeSymbol: 'dish-kit#json',
  create: () => ({ parse: (value: unknown) => value }),
}

/**
 * Describe one remote method served through the gateway's source-mode
 * fallback, which answers with plain JSON (`src-json`). The default takes no
 * business parameters; pass `extra` for a stream, a cancellation signal or
 * strict parameter codecs.
 * @param pkg - the package name, the first half of the descriptor id.
 * @param namespace - the wire namespace and service key.
 * @param method - the remote method name.
 * @param extra - overrides merged over the defaults.
 */
export function remoteDescriptor(
  pkg: string,
  namespace: string,
  method: string,
  extra: Partial<InvocationDescriptor> = {},
): InvocationDescriptor {
  return {
    id: `${pkg}#${namespace}/${method}`,
    service: namespace,
    namespace,
    method,
    invocation: { kind: 'direct' },
    parameters: [],
    result: { mode: 'src-json' },
    ...extra,
  }
}

/**
 * The names the browser's namespace service already has: the gateway (`@deepseek-ai/dsh-api-gateway/client`) mounts each
 * namespace's methods on one Cordis service (`RemoteNamespaceService`, not exported) and refuses a method named like one of
 * its members, as "conflicts with its namespace service", which fails the whole plugin's load. These are that class's fields
 * and methods in 0.2.0-rc.2, copied; anything every object has (`toString`) is refused the same way. A method with one of
 * these names can't be exposed to the browser: call it something else.
 */
export const RESERVED_REMOTE_METHODS: readonly string[] = [
  'ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace',
  'assertMethodAvailable', 'has', 'install', 'installDirect', 'installScoped', 'remove',
]

/**
 * Bundle descriptors for `ctx.remote.$mount`.
 * @param pkg - the package name.
 * @param descriptors - the package's remote methods.
 * @throws if a method is named like a member of the browser's namespace service (`RESERVED_REMOTE_METHODS`): that would not
 *   mount, and the failure it causes in the browser says nothing of the cause.
 */
export function remoteContribution(pkg: string, descriptors: InvocationDescriptor[]): TypertRemoteContribution {
  for (const { namespace, method } of descriptors) {
    if (RESERVED_REMOTE_METHODS.includes(method) || method in Object.prototype) {
      throw new Error(
        `${pkg}: the remote method "${method}" (${namespace}/${method}) clashes with a member of the browser's namespace service, ` +
        'which refuses to mount it; give the method another name',
      )
    }
  }
  return { package: pkg, descriptors }
}
