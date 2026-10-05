/**
 * The Browser tab's, the header button's and the screenshot row's styles. Added while the module factory runs, so the client
 * module loader tags the element with this plugin's id and removes it on unload.
 *
 * Colours come from `--dsw-alias-*` tokens only, so everything follows the theme (as orchestrator's `client/styles.ts`).
 * Nothing is wider than its container: text from a page (a URL, a title, a notice) wraps anywhere.
 *
 * The tab is a size container: the toolbar wraps below 360px, the address taking a line of its own. The picture's box fills
 * what the stage has left, whatever the image's size, so `Picture` can measure the room and draw the frame to fit it.
 */

const css = `
.dish-browser {
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 8px;
  container: dish-browser / inline-size;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.dish-browser *,
.dish-browser *::before,
.dish-browser *::after {
  box-sizing: border-box;
}
.dish-browser-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.dish-browser-tool,
.dish-browser-close,
.dish-browser-dismiss {
  flex: none;
  min-width: 28px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}
.dish-browser-tool:hover:not(:disabled),
.dish-browser-close:hover,
.dish-browser-dismiss:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dish-browser-tool:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.dish-browser-address-form {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
}
.dish-browser-address {
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.dish-browser-address:disabled {
  color: var(--dsw-alias-label-tertiary);
}
.dish-browser-address:focus {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: -1px;
}
.dish-browser-switch {
  min-width: 0;
}
.dish-browser-switcher {
  max-width: 100%;
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.dish-browser-line {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dish-browser-acting {
  color: var(--dsw-alias-state-business-primary);
}
.dish-browser-warn {
  color: var(--dsw-alias-state-warn-label);
}
.dish-browser-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  color: var(--dsw-alias-label-primary);
}
.dish-browser-notice-text {
  flex: 1 1 auto;
  min-width: 0;
  white-space: pre-wrap;
}
.dish-browser-stage {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  gap: 6px;
  min-width: 0;
  min-height: 240px;
}
.dish-browser-message {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
}
.dish-browser-picture {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-radius: 8px;
  outline: none;
  cursor: default;
  touch-action: none;
  user-select: none;
}
.dish-browser-picture:focus {
  box-shadow: inset 0 0 0 2px var(--dsw-alias-state-business-primary);
}
.dish-browser-frame {
  display: block;
  max-width: 100%;
  max-height: 100%;
  border: 1px solid var(--dsw-alias-border-l3);
}
.dish-browser-picture-dimmed .dish-browser-frame {
  opacity: 0.4;
  filter: grayscale(1);
}
.dish-browser-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dish-browser-header-button {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.dish-browser-header-button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dish-browser-shot {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.dish-browser-shot-line,
.dish-browser-shot-head {
  color: var(--dsw-alias-label-secondary);
}
.dish-browser-shot-text {
  white-space: pre-wrap;
  color: var(--dsw-alias-label-secondary);
}
.dish-browser-shot-open {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dish-browser-shot-image {
  display: block;
  width: auto;
  max-width: min(480px, 100%);
  height: auto;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
}
.dish-browser-shot-url {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dish-browser-shot-title {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
@container dish-browser (max-width: 360px) {
  .dish-browser-toolbar {
    flex-wrap: wrap;
  }
  .dish-browser-address-form {
    order: 10;
    flex-basis: 100%;
  }
}
`

const style = document.createElement('style')
style.textContent = css
document.head.append(style)
