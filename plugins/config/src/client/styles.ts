/**
 * The page's styles. Added while the module factory runs, so the client module loader tags the element with this
 * plugin's id and removes it on unload.
 *
 * Colours come from `--dsw-alias-*` tokens only, so the page follows the theme. Nothing here sets a width wider than
 * its container: at phone width the page does not scroll sideways, and a diff scrolls inside its own box.
 */

const css = `
.dish-history {
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  min-width: 0;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dish-history *,
.dish-history *::before,
.dish-history *::after {
  box-sizing: border-box;
}
.dish-history-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dish-history-intro {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-history-remote {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin: 0;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dish-history-muted {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-history-text {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.dish-history-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dish-history-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dish-history-filter-input {
  flex: 1 1 auto;
  min-width: 0;
}
.dish-history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dish-history-list > li {
  min-width: 0;
}
.dish-history-row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dish-history-row:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dish-history-row:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-history-row-top,
.dish-history-meta-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  margin: 0;
  min-width: 0;
}
.dish-history-author {
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dish-history-sha {
  margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.dish-history-meta-line .dish-history-sha {
  margin-left: 0;
  user-select: all;
}
.dish-history-row-text {
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.dish-history-paths {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  min-width: 0;
}
.dish-history-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dish-history-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.dish-history-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dish-history-card-title {
  margin: 0;
  min-width: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.dish-history-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dish-history-group-title {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
}
.dish-history-details {
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
}
.dish-history-details > summary {
  cursor: pointer;
  font-size: 12px;
}
.dish-history-message {
  margin: 8px 0 0;
  padding: 8px 10px;
  max-width: 100%;
  overflow-x: auto;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
}
.dish-history-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.dish-history-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-history-reason {
  width: 100%;
}
.dish-history-stale {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-warn-label);
}
.dish-history-notice {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-history-notice-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-history-notice-success {
  border-color: var(--dsw-alias-state-success-primary);
}
.dish-history-notice-error {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.dish-history-diffs {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dish-history-file {
  min-width: 0;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  overflow: hidden;
}
.dish-history-file-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 6px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-1);
}
.dish-history-diff {
  margin: 0;
  max-width: 100%;
  overflow-x: auto;
  background: var(--dsw-alias-markdown-code-block);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
}
.dish-history-diff:focus-visible {
  outline: 1px solid var(--dsw-alias-state-business-primary);
  outline-offset: -1px;
}
.dish-history-diff-lines {
  display: inline-block;
  min-width: 100%;
  padding: 4px 0;
  font: inherit;
}
.dish-history-line {
  display: block;
  min-height: 18px;
  padding: 0 10px;
  white-space: pre;
  color: var(--dsw-alias-label-secondary);
}
.dish-history-line-meta,
.dish-history-line-note {
  color: var(--dsw-alias-label-tertiary);
}
.dish-history-line-hunk {
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dish-history-line-add {
  color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-code-diff-added);
  box-shadow: inset 3px 0 0 var(--dsw-alias-state-success-primary);
}
.dish-history-line-remove {
  color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-code-diff-deleted);
  box-shadow: inset 3px 0 0 var(--dsw-alias-state-error-primary);
}
`

const style = document.createElement('style')
style.textContent = css
document.head.append(style)
