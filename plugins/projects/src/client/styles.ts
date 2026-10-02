/**
 * The page's styles. Added while the module factory runs, so the client module loader tags the element with this
 * plugin's id and removes it on unload.
 *
 * Colours come from `--dsw-alias-*` tokens only, so the page follows the theme. Nothing here sets a width wider than
 * its container: at phone width the page does not scroll sideways.
 *
 * The layout follows the width of the page itself, not the window's: it sits in Settings' content column, which the nav
 * makes much narrower than the window. So `.dish-projects` is a size container (as dsh's own settings pages are, with the
 * `width: 100%` that keeps a size container from collapsing), and the list of projects gives way to a select below 560px.
 */

const css = `
.dish-projects {
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 880px;
  container: dish-projects / inline-size;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dish-projects *,
.dish-projects *::before,
.dish-projects *::after {
  box-sizing: border-box;
}
.dish-projects-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dish-projects-intro {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-projects-muted {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.dish-projects-text {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.dish-projects-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dish-projects-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.dish-projects-sr {
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

/* The projects, and the one open */
.dish-projects-layout {
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
  min-width: 0;
}
.dish-projects-main {
  min-width: 0;
}
.dish-projects-side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dish-projects-add {
  align-self: flex-start;
}
.dish-projects-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dish-projects-item-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dish-projects-item-list > li {
  min-width: 0;
}
.dish-projects-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
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
.dish-projects-item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dish-projects-item:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-projects-item[aria-current="true"] {
  border-color: var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dish-projects-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}
.dish-projects-item-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-projects-item-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  min-width: 0;
  font-weight: 400;
}
.dish-projects-badge {
  flex: none;
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-state-warn-primary);
  border-radius: 9px;
  color: var(--dsw-alias-state-warn-label);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
}
.dish-projects-select {
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
.dish-projects-select:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-projects-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  min-width: 0;
}
.dish-projects-project-title {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.dish-projects-facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 14px;
  margin: 0;
  min-width: 0;
}
.dish-projects-facts dt {
  color: var(--dsw-alias-label-tertiary);
}
.dish-projects-facts dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-projects-bad {
  color: var(--dsw-alias-state-error-primary);
}

/* The form */
.dish-projects-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dish-projects-form-title {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.dish-projects-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  min-width: 0;
}
.dish-projects-wide {
  grid-column: 1 / -1;
}
.dish-projects-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.dish-projects-label {
  padding: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-projects-input {
  width: 100%;
}
.dish-projects-mono input {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dish-projects-env-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.dish-projects-env-row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dish-projects-check {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dish-projects-check:empty {
  display: none;
}
.dish-projects-check-stale {
  opacity: 0.6;
}
.dish-projects-problem {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}
.dish-projects-note {
  margin: 0;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  overflow-wrap: anywhere;
}
.dish-projects-note-warn {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-label);
}
.dish-projects-note-error {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.dish-projects-note-skipped {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dish-projects-note-skipped .dish-projects-code {
  padding: 6px 8px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-settings-card-fill);
  color: var(--dsw-alias-label-primary);
  user-select: all;
}
.dish-projects-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.dish-projects .dish-projects-danger {
  color: var(--dsw-alias-state-error-primary);
}
.dish-projects-confirm,
.dish-projects-conflict {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-projects-conflict {
  border-color: var(--dsw-alias-state-warn-primary);
}
.dish-projects-changes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dish-projects-changes > li {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-projects-was {
  text-decoration: line-through;
  color: var(--dsw-alias-label-tertiary);
}

/* What the last thing did. The notice bar stays at the top of the view: a save is made at the bottom of a long form, far from the page's head. A load error is part of its view and does not. */
.dish-projects-notice {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-settings-card-fill);
}
.dish-projects-notice-bar {
  position: sticky;
  top: 0;
  z-index: 1;
}
.dish-projects-notice-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-projects-notice-success {
  border-color: var(--dsw-alias-state-success-primary);
}
.dish-projects-notice-error {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}

@container dish-projects (width < 560px) {
  .dish-projects-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .dish-projects-items {
    display: none;
  }
  .dish-projects-select {
    display: block;
  }
  .dish-projects-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .dish-projects-facts {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
  .dish-projects-facts dd {
    margin-bottom: 6px;
  }
  .dish-projects-env-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .dish-projects-env-row > :first-child {
    grid-column: 1 / -1;
  }
}
`

const style = document.createElement('style')
style.textContent = css
document.head.append(style)
