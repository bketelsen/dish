/** The dish preset's patch file, made from the text of dsh-web-app's standard preset. */
export function generate(standardText: string, version: string): string

/** The standard preset as the dsh-web-app that dsh itself resolves ships it. */
export function readStandard(): { text: string, version: string, path: string, packagePath: string }
