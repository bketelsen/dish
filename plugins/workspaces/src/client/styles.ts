/**
 * The card's styles. Added while the module factory runs, so the client module loader tags the element with this plugin's id
 * and removes it on unload.
 *
 * Colours come from `--dsw-alias-*` tokens only, so the card follows the theme. Nothing here sets a width wider than its
 * container: at phone width the page does not scroll sideways, and every run of text that came from outside (GitHub's error, an
 * account's name) wraps anywhere rather than push the page wider.
 *
 * The layout follows the width of the card itself, not the window's: it sits in Settings' content column, which the nav makes
 * much narrower than the window. So `.dish-workspaces` is a size container (as dsh's own settings pages are, with the
 * `width: 100%` that keeps a size container from collapsing), and the facts' columns give way below 560px.
 */

const css = `
.dish-workspaces {
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 880px;
  container: dish-workspaces / inline-size;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dish-workspaces *,
.dish-workspaces *::before,
.dish-workspaces *::after {
  box-sizing: border-box;
}
.dish-workspaces-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dish-workspaces-intro {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-workspaces-muted {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.dish-workspaces-text {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.dish-workspaces-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dish-workspaces-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}

/* The cards */
.dish-workspaces-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 14px 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.dish-workspaces-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
  min-width: 0;
}
.dish-workspaces-card-title,
.dish-workspaces-label-title {
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
.dish-workspaces-label-title {
  font-size: 13px;
}
.dish-workspaces-credential {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px 0 0;
  border-top: 0.5px solid var(--dsw-alias-border-l3);
}
.dish-workspaces-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

/* The fields */
.dish-workspaces-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dish-workspaces-label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-workspaces-input {
  width: 100%;
  min-width: 0;
}
.dish-workspaces-native {
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
.dish-workspaces-native:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dish-workspaces-native[readonly],
.dish-workspaces-native:disabled {
  color: var(--dsw-alias-label-secondary);
}
.dish-workspaces-textarea {
  min-height: 84px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
  resize: vertical;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
/* The key is drawn as dots while it is typed, where the browser can (the characters and the line breaks are the PEM's all the same). */
.dish-workspaces-secret {
  -webkit-text-security: disc;
}

/* Notes, notices and the question before a removal */
.dish-workspaces-note {
  margin: 0;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  overflow-wrap: anywhere;
}
.dish-workspaces-note-warn {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-label);
}
.dish-workspaces-note-error {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.dish-workspaces-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-workspaces-notice {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.dish-workspaces-notice-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-workspaces-notice-success {
  border-color: var(--dsw-alias-state-success-primary);
}
.dish-workspaces-notice-error {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}

/* What GitHub says */
.dish-workspaces-facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 16px;
  margin: 0;
}
.dish-workspaces-facts > dt {
  color: var(--dsw-alias-label-tertiary);
}
.dish-workspaces-facts > dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dish-workspaces-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dish-workspaces-installation {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  min-width: 0;
}

@container dish-workspaces (width < 560px) {
  .dish-workspaces-facts {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
  .dish-workspaces-facts > dd {
    margin-bottom: 6px;
  }
}
`

const style = document.createElement('style')
style.textContent = css
document.head.append(style)
