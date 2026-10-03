/**
 * The page's styles. Added while the module factory runs, so the client module loader tags the element with this plugin's id
 * and removes it on unload.
 *
 * Colours come from `--dsw-alias-*` tokens only, so the page follows the theme (as workspaces' `client/styles.ts`). Nothing here
 * sets a width wider than its container: at phone width the page does not scroll sideways, and every run of text that came
 * from a run (a goal, a path, a summary, a URL) wraps anywhere rather than push the page wider.
 *
 * The layout follows the width of the page itself, not the window's: it sits in Settings' content column, which the nav makes
 * much narrower than the window. So `.dish-runs` is a size container (with the `width: 100%` that keeps a size container from
 * collapsing), and the facts' columns give way below 560px.
 */

const css = `
.dish-runs {
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 880px;
  container: dish-runs / inline-size;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.dish-runs *,
.dish-runs *::before,
.dish-runs *::after {
  box-sizing: border-box;
}
/* Every box that holds text from a run may shrink below its content, so the text wraps rather than push the page wider. */
.dish-runs-card,
.dish-runs-groups,
.dish-runs-group,
.dish-runs-list > li,
.dish-runs-plain-list > li,
.dish-runs-entries > li,
.dish-runs-row,
.dish-runs-row-button,
.dish-runs-goal,
.dish-runs-meta,
.dish-runs-view,
.dish-runs-facts,
.dish-runs-facts > dd,
.dish-runs-task,
.dish-runs-task-head,
.dish-runs-entry,
.dish-runs-entry-head,
.dish-runs-timeline,
.dish-runs-notice-body {
  min-width: 0;
  max-width: 100%;
}
.dish-runs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.dish-runs-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dish-runs-intro {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-runs-muted {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.dish-runs-text {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.dish-runs-error {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}
.dish-runs-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
  word-break: break-all;
}
.dish-runs-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dish-runs-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

/* The cards */
.dish-runs-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}

/* Plain buttons: Back, Load older, and the rows */
.dish-runs-button {
  margin: 0;
  padding: 4px 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dish-runs-button:hover {
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-runs-button:focus-visible,
.dish-runs-row-button:focus-visible {
  outline: 1px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}

/* The list */
.dish-runs-groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dish-runs-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dish-runs-group-title,
.dish-runs-section-title,
.dish-runs-view-title {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.dish-runs-section-title {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l3);
}
.dish-runs-list,
.dish-runs-plain-list,
.dish-runs-entries {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dish-runs-row {
  display: flex;
  align-items: flex-start;
  gap: 8px 12px;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-runs-row:hover {
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-runs-row-button {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dish-runs-goal {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
  overflow-wrap: anywhere;
}
.dish-runs-meta,
.dish-runs-task-head,
.dish-runs-entry-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
}
.dish-runs-row-pr {
  flex: 0 0 auto;
}
.dish-runs-pr {
  color: var(--dsw-alias-state-business-primary);
  text-decoration: none;
}
.dish-runs-pr:hover {
  text-decoration: underline;
}
.dish-runs-tag {
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dish-runs-tag-open {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
}
.dish-runs-tag-pr {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}
.dish-runs-tag-abandoned {
  color: var(--dsw-alias-label-tertiary);
}

/* A run */
.dish-runs-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dish-runs-facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 16px;
  margin: 0;
}
.dish-runs-facts > dt {
  color: var(--dsw-alias-label-tertiary);
}
.dish-runs-facts > dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.dish-runs-task,
.dish-runs-entry {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-runs-mark {
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

/* The timeline */
.dish-runs-timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dish-runs-by {
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-runs-by-main {
  color: var(--dsw-alias-state-business-primary);
}
.dish-runs-label {
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dish-runs-entry-text {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Notices */
.dish-runs-notice {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-runs-notice-body {
  display: flex;
  flex-direction: column;
  overflow-wrap: anywhere;
}
.dish-runs-notice-error {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}

@container dish-runs (width < 560px) {
  .dish-runs-facts {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
  .dish-runs-facts > dd {
    margin-bottom: 6px;
  }
  .dish-runs-row {
    flex-direction: column;
  }
}
`

const style = document.createElement('style')
style.textContent = css
document.head.append(style)
