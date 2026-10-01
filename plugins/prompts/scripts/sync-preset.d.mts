/** The dish preset's patch file, made from the text of dsh-web-app's standard preset. */
export function generate(standardText: string, version: string): string

/** The standard preset as the installed dsh-web-app ships it. */
export function readStandard(): { text: string, version: string, path: string }
