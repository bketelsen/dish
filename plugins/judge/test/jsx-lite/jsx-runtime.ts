/**
 * A JSX runtime for tests: it builds plain element objects, and the test renders them to HTML text (`render` in
 * `client-rendering.test.ts`) the way a browser would show them: text children and attribute values escaped, and nothing else
 * taken for markup. The page's components are compiled against this instead of React, which the workspace does not install (the
 * browser supplies it), so what they do with the strings they are given can be checked under Node.
 *
 * It has no `dangerouslySetInnerHTML`: an element that carries one is refused by the renderer, so a component that reached for
 * it could not pass a test, as it could not pass the scan of its source.
 */

export const Fragment = Symbol.for('jsx-lite.fragment')

export interface Element {
  $$typeof: 'jsx-lite.element'
  type: unknown
  props: Record<string, unknown>
  key: string | undefined
}

export function jsx(type: unknown, props: Record<string, unknown>, key?: string): Element {
  return { $$typeof: 'jsx-lite.element', type, props, key }
}

export const jsxs = jsx
