/**
 * The styles of `DiffView`.
 *
 * They are added while the plugin's client module factory runs (this module is evaluated as part of the bundle), so the
 * client module loader tags the element with that plugin's id and removes it when the plugin unloads. That is why
 * this is a top-level side effect and not something `DiffView` does when it first renders: a style added later would
 * belong to no plugin and stay behind. Each plugin whose bundle includes `DiffView` gets a copy of its own, and two
 * identical blocks do no harm; sharing one would take the diff's styles away from one plugin when the other unloads.
 * A bundle evaluates this module once, and `installDiffStyles` is a no-op the second time anyway.
 *
 * Colours come from `--dsw-alias-*` tokens only, so a diff follows the theme. The class names are the diff's own, not any
 * page's, and the root sets what the page it sits in used to hand down (box-sizing, size, colour), so a diff looks the
 * same wherever it is placed. Nothing here sets a width wider than its container: a diff scrolls inside its own box.
 */

export const DIFF_CSS = `
.dish-diff-files {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dish-diff-files *,
.dish-diff-files *::before,
.dish-diff-files *::after {
  box-sizing: border-box;
}
.dish-diff-muted {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-diff-file {
  min-width: 0;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  overflow: hidden;
}
.dish-diff-file-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 6px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-1);
}
.dish-diff-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dish-diff-code {
  margin: 0;
  max-width: 100%;
  overflow-x: auto;
  background: var(--dsw-alias-markdown-code-block);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
}
.dish-diff-code:focus-visible {
  outline: 1px solid var(--dsw-alias-state-business-primary);
  outline-offset: -1px;
}
.dish-diff-lines {
  display: inline-block;
  min-width: 100%;
  padding: 4px 0;
  font: inherit;
}
.dish-diff-line {
  display: block;
  min-height: 18px;
  padding: 0 10px;
  white-space: pre;
  color: var(--dsw-alias-label-secondary);
}
.dish-diff-line-meta,
.dish-diff-line-note {
  color: var(--dsw-alias-label-tertiary);
}
.dish-diff-line-hunk {
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dish-diff-line-add {
  color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-code-diff-added);
  box-shadow: inset 3px 0 0 var(--dsw-alias-state-success-primary);
}
.dish-diff-line-remove {
  color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-code-diff-deleted);
  box-shadow: inset 3px 0 0 var(--dsw-alias-state-error-primary);
}
`

let installed = false

/** Add the diff's styles to the page, once for this copy of the module. Does nothing where there is no document. */
export function installDiffStyles(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  const style = document.createElement('style')
  style.textContent = DIFF_CSS
  document.head.append(style)
}

installDiffStyles()
