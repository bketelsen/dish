/**
 * The page's styles. Added while the module factory runs, so the client module loader tags the element with this
 * plugin's id and removes it on unload.
 *
 * Colours come from `--dsw-alias-*` tokens only, so the page follows the theme. Nothing here sets a width wider than
 * its container: at phone width the page does not scroll sideways, and every run of text that came from outside (a command, a
 * tool's name, withheld content) wraps anywhere rather than push the page wider.
 *
 * The layout follows the width of the page itself, not the window's: it sits in Settings' content column, which the nav
 * makes much narrower than the window. So `.dish-judge` is a size container (as dsh's own settings pages are, with the
 * `width: 100%` that keeps a size container from collapsing), and the form's columns give way below 560px.
 *
 * The diff's own rules (`.dish-diff-*`) are dish-kit's, added by `DiffView`'s module when this bundle loads.
 */

const css = `
.dish-judge {
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 880px;
  container: dish-judge / inline-size;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dish-judge *,
.dish-judge *::before,
.dish-judge *::after {
  box-sizing: border-box;
}
.dish-judge-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dish-judge-intro {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-judge-muted {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.dish-judge-text {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.dish-judge-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dish-judge-code,
.dish-judge-sha {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.dish-judge-sha {
  color: var(--dsw-alias-label-tertiary);
}
.dish-judge-sr {
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

/* The cards */
.dish-judge-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 14px 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.dish-judge-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
  min-width: 0;
}
.dish-judge-card-title {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  min-width: 0;
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dish-judge-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.dish-judge-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dish-judge-label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-judge-input,
.dish-judge-select {
  width: 100%;
  min-width: 0;
}
.dish-judge-native {
  display: block;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 6px 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-settings-card-fill);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.dish-judge-native:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-judge-native[readonly],
.dish-judge-native:disabled {
  color: var(--dsw-alias-label-secondary);
}
.dish-judge-textarea {
  min-height: 84px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
  resize: vertical;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.dish-judge-note {
  margin: 0;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  overflow-wrap: anywhere;
}
.dish-judge-note-warn {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-label);
}
.dish-judge-confirm,
.dish-judge-conflict {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-judge-conflict {
  border-color: var(--dsw-alias-state-warn-primary);
}

/* The key and the status */
.dish-judge-key-row {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.dish-judge-key-row > .dish-judge-field {
  flex: 1 1 260px;
}
.dish-judge-facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 16px;
  margin: 0;
}
.dish-judge-facts > dt {
  color: var(--dsw-alias-label-tertiary);
}
.dish-judge-facts > dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-judge-test {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}

/*
 * The tabs are dsh's SegmentedTabs: equal columns that can't be narrower than their label, since a grid item's minimum is its
 * content. The tab gives up its minimum and the label shortens with an ellipsis instead, so neighbours never overlap.
 */
.dish-judge-tabs {
  min-width: 0;
  max-width: 320px;
}
.dish-judge-tabs [role="tab"] {
  min-width: 0;
  overflow: hidden;
}
.dish-judge-tab-label {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The thresholds form */
.dish-judge-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.dish-judge-group > legend {
  padding: 0;
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.dish-judge-columns {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 12px;
  min-width: 0;
}
.dish-judge-columns-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

/* The history */
.dish-judge-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dish-judge-list > li {
  min-width: 0;
}
.dish-judge-commit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-judge-commit-title {
  font-weight: 500;
}
.dish-judge-meta-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  margin: 0;
  min-width: 0;
}
.dish-judge-author {
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

/* The decisions */
.dish-judge-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
  gap: 8px 12px;
  min-width: 0;
}
.dish-judge-lines {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dish-judge-lines > li {
  min-width: 0;
}
.dish-judge-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-judge-row-top {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  min-width: 0;
}
.dish-judge-purpose {
  font-size: 11px;
  line-height: 16px;
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
}
.dish-judge-decision {
  font-weight: 500;
}
.dish-judge-tone-success {
  color: var(--dsw-alias-state-success-primary);
}
.dish-judge-tone-warning {
  color: var(--dsw-alias-state-warn-label);
}
.dish-judge-tone-danger {
  color: var(--dsw-alias-state-error-primary);
}
.dish-judge-tone-neutral {
  color: var(--dsw-alias-label-secondary);
}
.dish-judge-subject {
  display: block;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dish-judge-reading {
  display: flex;
  flex-wrap: wrap;
  gap: 0 14px;
  margin: 0;
  min-width: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dish-judge-error {
  margin: 0;
  font-size: 12px;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.dish-judge-group-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 8px 8px 8px 12px;
  border-left: 2px solid var(--dsw-alias-border-l3);
}
.dish-judge-group-card .dish-judge-row {
  background: var(--dsw-alias-settings-card-fill);
}
.dish-judge-link {
  align-self: flex-start;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-state-business-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dish-judge-link:hover {
  text-decoration: underline;
}
.dish-judge-link:focus-visible {
  outline: 1px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}
.dish-judge-withheld {
  margin: 0;
  max-height: 50vh;
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

/* What the last thing did */
.dish-judge-notice {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-judge-notice-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-judge-notice-success {
  border-color: var(--dsw-alias-state-success-primary);
}
.dish-judge-notice-error {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}

@container dish-judge (width < 560px) {
  .dish-judge-columns,
  .dish-judge-columns-2,
  .dish-judge-filters {
    grid-template-columns: minmax(0, 1fr);
  }
  .dish-judge-facts {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
  .dish-judge-facts > dd {
    margin-bottom: 6px;
  }
  .dish-judge-tabs [role="tab"] {
    padding: 0 8px;
    font-size: 13px;
  }
}
`

const style = document.createElement('style')
style.textContent = css
document.head.append(style)
