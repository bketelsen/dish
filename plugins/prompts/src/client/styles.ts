/**
 * The page's styles. Added while the module factory runs, so the client module loader tags the element with this
 * plugin's id and removes it on unload.
 *
 * Colours come from `--dsw-alias-*` tokens only, so the page follows the theme. Nothing here sets a width wider than
 * its container: at phone width the page does not scroll sideways.
 *
 * The layout follows the width of the page itself, not the window's: it sits in Settings' content column, which the nav
 * makes much narrower than the window. So `.dish-prompts` is a size container (as dsh's own settings pages are, with the
 * `width: 100%` that keeps a size container from collapsing), and the list of roles gives way to a select below 560px.
 *
 * The diff's own rules (`.dish-diff-*`) are dish-kit's, added by `DiffView`'s module when this bundle loads.
 */

const css = `
.dish-prompts {
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 880px;
  container: dish-prompts / inline-size;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dish-prompts *,
.dish-prompts *::before,
.dish-prompts *::after {
  box-sizing: border-box;
}
.dish-prompts-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dish-prompts-intro {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-prompts-muted {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.dish-prompts-text {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.dish-prompts-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dish-prompts-code,
.dish-prompts-path,
.dish-prompts-sha {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.dish-prompts-path,
.dish-prompts-sha {
  color: var(--dsw-alias-label-tertiary);
}
.dish-prompts-sr {
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

/* The roles, and the one open */
.dish-prompts-layout {
  display: grid;
  grid-template-columns: 184px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
  min-width: 0;
}
.dish-prompts-main {
  min-width: 0;
}
.dish-prompts-roles {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dish-prompts-roles-heading {
  margin: 8px 0 0;
  padding: 0 10px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
}
.dish-prompts-role-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dish-prompts-role-list > li {
  min-width: 0;
}
.dish-prompts-role {
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
.dish-prompts-role:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dish-prompts-role:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-prompts-role[aria-current="true"] {
  border-color: var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dish-prompts-role-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-prompts-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary);
}
.dish-prompts-count {
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
.dish-prompts-role-select {
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
.dish-prompts-role-select:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-prompts-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  min-width: 0;
}
.dish-prompts-role-title {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

/*
 * The tabs are dsh's SegmentedTabs: equal columns that can't be narrower than their label, since a grid item's minimum is its
 * content. At a narrow width the labels ran into each other. The tab gives up its minimum and the label shortens with an
 * ellipsis instead, so neighbours never overlap, and the padding and size come down as the page narrows.
 */
.dish-prompts-tabs {
  min-width: 0;
}
.dish-prompts-tabs [role="tab"] {
  min-width: 0;
  padding: 0 8px;
  overflow: hidden;
  font-size: 13px;
}
.dish-prompts-tab-label {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The editor */
.dish-prompts-textarea {
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 280px;
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
.dish-prompts-textarea:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-prompts-textarea[readonly] {
  color: var(--dsw-alias-label-secondary);
}
.dish-prompts-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dish-prompts-label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-prompts-note-input {
  width: 100%;
}
.dish-prompts-note {
  margin: 0;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  overflow-wrap: anywhere;
}
.dish-prompts-note-warn {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-label);
}
.dish-prompts-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.dish-prompts-confirm,
.dish-prompts-conflict {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-prompts-conflict {
  border-color: var(--dsw-alias-state-warn-primary);
}
.dish-prompts-details {
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
}
.dish-prompts-details > summary {
  cursor: pointer;
  font-size: 12px;
}
.dish-prompts-variables {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.dish-prompts-variables > li {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  min-width: 0;
}

/* The preview */
.dish-prompts-preview {
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

/* The history */
.dish-prompts-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dish-prompts-list > li {
  min-width: 0;
}
.dish-prompts-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.dish-prompts-card-title {
  font-weight: 500;
}
.dish-prompts-meta-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  margin: 0;
  min-width: 0;
}
.dish-prompts-author {
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

/* What the last thing did */
.dish-prompts-notice {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-prompts-notice-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-prompts-notice-success {
  border-color: var(--dsw-alias-state-success-primary);
}
.dish-prompts-notice-error {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}

@container dish-prompts (width < 560px) {
  .dish-prompts-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .dish-prompts-roles {
    display: none;
  }
  .dish-prompts-role-select {
    display: block;
  }
}
@container dish-prompts (width < 420px) {
  .dish-prompts-tabs [role="tab"] {
    padding: 0 4px;
    font-size: 12px;
  }
}
`

const style = document.createElement('style')
style.textContent = css
document.head.append(style)
