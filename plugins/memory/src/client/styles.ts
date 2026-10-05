/**
 * The page's styles, Settings → Prompts' adapted. Added while the module factory runs, so the client module loader tags the
 * element with this plugin's id and removes it on unload.
 *
 * Colours come from `--dsw-alias-*` tokens only, so the page follows the theme. Nothing here sets a width wider than
 * its container: at phone width the page does not scroll sideways.
 *
 * The layout follows the width of the page itself, not the window's: it sits in Settings' content column, which the nav
 * makes much narrower than the window. So `.dish-memory` is a size container (as dsh's own settings pages are, with the
 * `width: 100%` that keeps a size container from collapsing), and the list of scopes gives way to a select below 560px.
 *
 * The diff's own rules (`.dish-diff-*`) are dish-kit's, added by `DiffView`'s module when this bundle loads.
 */

const css = `
.dish-memory {
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 880px;
  container: dish-memory / inline-size;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dish-memory *,
.dish-memory *::before,
.dish-memory *::after {
  box-sizing: border-box;
}
.dish-memory-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dish-memory-intro {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-memory-muted {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.dish-memory-text {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.dish-memory-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dish-memory-path,
.dish-memory-sha {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.dish-memory-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.dish-memory-remote {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

/* The scopes, and the one shown */
.dish-memory-layout {
  display: grid;
  grid-template-columns: 184px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
  min-width: 0;
}
.dish-memory-main {
  min-width: 0;
}
.dish-memory-scopes {
  min-width: 0;
}
.dish-memory-scope-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dish-memory-scope-list > li {
  min-width: 0;
}
.dish-memory-scope {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 6px 10px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dish-memory-scope:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dish-memory-scope:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-memory-scope[aria-current="true"] {
  border-color: var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dish-memory-scope-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-memory-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary);
}
.dish-memory-count-badge {
  flex: none;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dish-memory-scope-select {
  display: none;
  width: 100%;
  min-width: 0;
  padding: 6px 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-settings-card-fill);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.dish-memory-scope-select:focus-visible,
.dish-memory-select:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-memory-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  min-width: 0;
}
.dish-memory-scope-title,
.dish-memory-subtitle {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

/* The tabs: see Settings → Prompts' styles for why a label gives way to an ellipsis instead of its tab's neighbours. */
.dish-memory-tabs {
  min-width: 0;
}
.dish-memory-tabs [role="tab"] {
  min-width: 0;
  overflow: hidden;
}
.dish-memory-tab-label {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The list */
.dish-memory-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dish-memory-list > li {
  min-width: 0;
}
.dish-memory-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.dish-memory-card-held {
  border-color: var(--dsw-alias-state-warn-primary);
}
.dish-memory-card-title {
  font-weight: 500;
}
.dish-memory-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dish-memory-row:focus-visible {
  outline: 1px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}
.dish-memory-row-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 8px;
  min-width: 0;
}
.dish-memory-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.dish-memory-row:hover .dish-memory-name {
  text-decoration: underline;
}
.dish-memory-description {
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dish-memory-reason {
  margin: 0;
  color: var(--dsw-alias-state-warn-label);
  overflow-wrap: anywhere;
}

/* The editors */
.dish-memory-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dish-memory-label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-memory-input {
  width: 100%;
}
.dish-memory-select {
  width: 100%;
  min-width: 0;
  max-width: 240px;
  padding: 6px 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-settings-card-fill);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.dish-memory-textarea {
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 200px;
  margin: 0;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-settings-card-fill);
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  resize: vertical;
}
.dish-memory-textarea-tall {
  min-height: 320px;
}
.dish-memory-textarea:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-memory-count {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dish-memory-count-over {
  color: var(--dsw-alias-state-error-primary);
}
.dish-memory-note {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  overflow-wrap: anywhere;
}
.dish-memory-note-warn {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-label);
}
.dish-memory-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.dish-memory-confirm,
.dish-memory-conflict {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-memory-conflict {
  border-color: var(--dsw-alias-state-warn-primary);
}

/* What is there now, and the preview */
.dish-memory-theirs,
.dish-memory-preview {
  margin: 0;
  max-height: 60vh;
  padding: 10px 12px;
  overflow: auto;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dish-memory-theirs {
  max-height: 240px;
}

/* The history */
.dish-memory-meta-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  margin: 0;
  min-width: 0;
}
.dish-memory-author {
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

/* What the last thing did */
.dish-memory-notice {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-memory-notice-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-memory-notice-success {
  border-color: var(--dsw-alias-state-success-primary);
}
.dish-memory-notice-error {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}

@container dish-memory (width < 560px) {
  .dish-memory-tabs [role="tab"] {
    padding: 0 8px;
    font-size: 13px;
  }
  .dish-memory-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .dish-memory-scopes {
    display: none;
  }
  .dish-memory-scope-select {
    display: block;
  }
  .dish-memory-select {
    max-width: none;
  }
}
@container dish-memory (width < 420px) {
  .dish-memory-tabs [role="tab"] {
    padding: 0 4px;
    font-size: 12px;
  }
}
`

const style = document.createElement('style')
style.textContent = css
document.head.append(style)
