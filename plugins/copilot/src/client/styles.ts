/**
 * The card's styles. Added while the module factory runs, so the client module
 * loader tags the element with this plugin's id and removes it on unload.
 */

const css = `
.dish-copilot {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
  padding: 12px;
  border-radius: var(--dsw-radius-md);
  border: 0.5px solid var(--dsw-alias-border-l3);
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dish-copilot-first {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 24px;
}
.dish-copilot-first-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dish-copilot-first > .dish-copilot {
  margin-top: 8px;
}
.dish-copilot-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.dish-copilot-split {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}
.dish-copilot-split > .dish-copilot-row {
  min-width: 0;
}
.dish-copilot-actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}
.dish-copilot-device {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dish-copilot-spacer {
  flex: 1;
}
.dish-copilot-meta {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dish-copilot-code {
  padding: 2px 10px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-interactive-bg-hover);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 20px;
  line-height: 32px;
  letter-spacing: 0.08em;
  user-select: all;
}
.dish-copilot-error {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}
`

const style = document.createElement('style')
style.textContent = css
document.head.append(style)
