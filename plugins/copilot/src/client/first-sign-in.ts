/**
 * When the Models page's footer shows the first sign-in card. Pure, so a test
 * can run it without React.
 */

import type { CopilotStatus } from '../protocol.ts'

/**
 * Show the card once the status has loaded and `llm-pi-ai` has no
 * `github-copilot` route. A fresh profile has none, so the provider card
 * (which renders only on that route's row) has nowhere to appear; signed in or
 * not, the footer stays until the route exists, and then the provider card
 * takes over.
 */
export function showFirstSignIn(status: CopilotStatus | undefined): boolean {
  return status !== undefined && !status.route
}
