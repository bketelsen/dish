/**
 * The page's styles. Added while the module factory runs, so the client module loader tags the element with this
 * plugin's id and removes it on unload.
 *
 * Colours come from `--dsw-alias-*` tokens only, so the page follows the theme. Nothing here sets a width wider than
 * its container: at phone width the page does not scroll sideways.
 *
 * The layout follows the width of the page itself, not the window's: it sits in Settings' content column, which the nav
 * makes much narrower than the window. So `.dish-skills` is a size container (as dsh's own settings pages are, with the
 * `width: 100%` that keeps a size container from collapsing), and the list of skills gives way to a select below 560px.
 *
 * The diff's own rules (`.dish-diff-*`) are dish-kit's, added by `DiffView`'s module when this bundle loads.
 */

const css = `
.dish-skills {
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 880px;
  container: dish-skills / inline-size;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dish-skills *,
.dish-skills *::before,
.dish-skills *::after {
  box-sizing: border-box;
}
.dish-skills-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dish-skills-intro {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-skills-muted {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.dish-skills-text {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.dish-skills-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dish-skills-code,
.dish-skills-path,
.dish-skills-sha {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.dish-skills-path,
.dish-skills-sha {
  color: var(--dsw-alias-label-tertiary);
}
.dish-skills-sr {
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

/* The skills, and the one open */
.dish-skills-layout {
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
  min-width: 0;
}
.dish-skills-main {
  min-width: 0;
}
.dish-skills-side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dish-skills-new {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.dish-skills-new-input {
  flex: 1 1 120px;
  min-width: 0;
}
.dish-skills-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dish-skills-item-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dish-skills-item-list > li {
  min-width: 0;
}
.dish-skills-item {
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
div.dish-skills-item {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  cursor: default;
}
.dish-skills-item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
div.dish-skills-item:hover {
  background: transparent;
}
.dish-skills-item:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-skills-item[aria-current="true"] {
  border-color: var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dish-skills-item-missing .dish-skills-item-name {
  opacity: 0.6;
  font-style: italic;
}
.dish-skills-item-missing .dish-skills-chip {
  opacity: 0.6;
}
.dish-skills-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}
.dish-skills-item-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-skills-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary);
}
.dish-skills-count {
  flex: none;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
  font-size: 11px;
  line-height: 18px;
  font-weight: 500;
  text-align: center;
}
.dish-skills-badge {
  flex: none;
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-state-business-primary);
  border-radius: 9px;
  color: var(--dsw-alias-state-business-primary);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
}
.dish-skills-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
.dish-skills-chip {
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 9px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  font-weight: 400;
  overflow-wrap: anywhere;
}
.dish-skills-chip-quiet {
  color: var(--dsw-alias-label-tertiary);
}
.dish-skills-chip-problem {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.dish-skills-select {
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
.dish-skills-select:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-skills-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  min-width: 0;
}
.dish-skills-skill-title {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

/*
 * The tabs are dsh's SegmentedTabs: equal columns that can't be narrower than their label, since a grid item's minimum is its
 * content. At a narrow width the labels ran into each other. The tab gives up its minimum and the label shortens with an
 * ellipsis instead, so neighbours never overlap, at any width. Its own padding and size are left as dsh has them until the page
 * is narrow (below), where they come down.
 */
.dish-skills-tabs {
  min-width: 0;
}
.dish-skills-tabs [role="tab"] {
  min-width: 0;
  overflow: hidden;
}
.dish-skills-tab-label {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The editor */
.dish-skills-textarea {
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 320px;
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
.dish-skills-textarea:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-skills-textarea[readonly] {
  color: var(--dsw-alias-label-secondary);
}
.dish-skills-check {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dish-skills-check:empty {
  display: none;
}
.dish-skills-check-stale {
  opacity: 0.6;
}
.dish-skills-check-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-wrap: anywhere;
}
.dish-skills-problems {
  color: var(--dsw-alias-state-error-primary);
}
.dish-skills-warnings {
  color: var(--dsw-alias-state-warn-label);
}
.dish-skills-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dish-skills-label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-skills-note-input {
  width: 100%;
}
.dish-skills-note {
  margin: 0;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  overflow-wrap: anywhere;
}
.dish-skills-note-warn {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-label);
}
.dish-skills-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.dish-skills .dish-skills-danger {
  color: var(--dsw-alias-state-error-primary);
}
.dish-skills-confirm,
.dish-skills-conflict {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-skills-conflict {
  border-color: var(--dsw-alias-state-warn-primary);
}

/* The history */
.dish-skills-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dish-skills-list > li {
  min-width: 0;
}
.dish-skills-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.dish-skills-card-title {
  font-weight: 500;
}
.dish-skills-meta-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  margin: 0;
  min-width: 0;
}
.dish-skills-author {
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

/* What the last thing did. The notice bar stays at the top of the view: a save is made at the bottom of a long document, far from the page's head. A load error is part of its view and does not. */
.dish-skills-notice {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-settings-card-fill);
}
.dish-skills-notice-bar {
  position: sticky;
  top: 0;
  z-index: 1;
}
.dish-skills-notice-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-skills-notice-success {
  border-color: var(--dsw-alias-state-success-primary);
}
.dish-skills-notice-error {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}

@container dish-skills (width < 560px) {
  .dish-skills-tabs [role="tab"] {
    padding: 0 8px;
    font-size: 13px;
  }
  .dish-skills-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .dish-skills-items {
    display: none;
  }
  .dish-skills-select {
    display: block;
  }
}
@container dish-skills (width < 420px) {
  .dish-skills-tabs [role="tab"] {
    padding: 0 4px;
    font-size: 12px;
  }
}
`

const style = document.createElement('style')
style.textContent = css
document.head.append(style)
