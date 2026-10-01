/**
 * The diff view and the patches behind it, shared by the plugins' Settings pages. This module is bundled into
 * browsers: it may import only types from `@deepseek-ai/*` (plus `react` and the client UI primitives, which stay
 * external in a plugin's bundle) and nothing from `node:*`.
 *
 * `DiffView` needs React, so Node cannot load this file; a controller that only wants the patches and runs under
 * `node --test` imports `dish-kit/ui/diff`.
 * @module dish-kit/ui
 */

export { classifyPatch, patchTotals, unifiedDiff } from './diff.ts'
export type { DiffLine, DiffLineKind, FileDiff } from './diff.ts'
export { DiffView } from './DiffView.tsx'
