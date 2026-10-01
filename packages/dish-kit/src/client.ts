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
 * Bundle descriptors for `ctx.remote.$mount`.
 * @param pkg - the package name.
 * @param descriptors - the package's remote methods.
 */
export function remoteContribution(pkg: string, descriptors: InvocationDescriptor[]): TypertRemoteContribution {
  return { package: pkg, descriptors }
}
