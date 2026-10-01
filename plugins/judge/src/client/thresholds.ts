/**
 * The thresholds form's own logic: how `judge.yaml`'s settings become text fields and back, when the form counts as changed,
 * and which warnings it gives. Plain TypeScript with no DOM or React in it, so `node --test` can load it.
 *
 * **What is valid is the server's to say.** A field that is not a number as typed is sent as typed, and `parseSettings` on
 * the server refuses it in its own words (`commands.readOnly: "abc" is not a number from 0 to 1`). The page has no second
 * set of rules to keep in step; the warnings here are advice that doesn't block a save, about settings the check can't judge.
 *
 * @module dish-judge/client/thresholds
 */

import type { SettingsValues } from '../protocol.ts'

/** Every field of the form, as the text in it. */
export interface ThresholdForm {
  model: string
  timeoutMs: string
  readOnly: string
  reversible: string
  servesTask: string
  withhold: string
  warn: string
  chunkChars: string
  /** `tools.gated`, one name per line. */
  gated: string
  /** `tools.screened`, one name per line. */
  screened: string
}

export type FieldName = keyof ThresholdForm

/** The form for `settings`: numbers as they read (`0.9`), the lists one name to a line. */
export function formOf(settings: SettingsValues): ThresholdForm {
  return {
    model: settings.model,
    timeoutMs: String(settings.timeoutMs),
    readOnly: String(settings.commands.readOnly),
    reversible: String(settings.commands.reversible),
    servesTask: String(settings.commands.servesTask),
    withhold: String(settings.screening.withhold),
    warn: String(settings.screening.warn),
    chunkChars: String(settings.screening.chunkChars),
    gated: settings.tools.gated.join('\n'),
    screened: settings.tools.screened.join('\n'),
  }
}

/** A tool list from its lines: each trimmed, and the blank ones dropped. A name that is repeated is left, for the person to take out. */
export function toolsOf(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
}

/** A plain decimal number, with an optional sign and exponent: what `Number` reads that a person meant as one. No hex, no `Infinity`, no empty. */
const DECIMAL = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/

/** `text` as the number it says, or as typed when it isn't one: the server's check refuses it with a message. */
function numberOf(text: string): number | string {
  const trimmed = text.trim()
  return DECIMAL.test(trimmed) ? Number(trimmed) : text
}

/**
 * What the form would send. A field that is not a number as typed is sent as the text typed (so the type says `number` and the
 * value may not be one: the server refuses it, by its path), and the model is trimmed.
 */
export function settingsOf(form: ThresholdForm): SettingsValues {
  return {
    model: form.model.trim(),
    timeoutMs: numberOf(form.timeoutMs) as number,
    commands: {
      readOnly: numberOf(form.readOnly) as number,
      reversible: numberOf(form.reversible) as number,
      servesTask: numberOf(form.servesTask) as number,
    },
    screening: {
      withhold: numberOf(form.withhold) as number,
      warn: numberOf(form.warn) as number,
      chunkChars: numberOf(form.chunkChars) as number,
    },
    tools: { gated: toolsOf(form.gated), screened: toolsOf(form.screened) },
  }
}

/** Whether two settings say the same: key by key, in a fixed order, so the order an object was built in is nothing. */
export function sameSettings(a: SettingsValues, b: SettingsValues): boolean {
  const canonical = (settings: SettingsValues): string => JSON.stringify([
    settings.model, settings.timeoutMs,
    settings.commands.readOnly, settings.commands.reversible, settings.commands.servesTask,
    settings.screening.withhold, settings.screening.warn, settings.screening.chunkChars,
    settings.tools.gated, settings.tools.screened,
  ])
  return canonical(a) === canonical(b)
}

/** Whether `list` covers `tool`: it names it, or has a prefix ending in `*` that it starts with. The gate's own matching. */
export function covers(list: readonly string[], tool: string): boolean {
  return list.some(entry => entry.endsWith('*') ? tool.startsWith(entry.slice(0, -1)) : entry === tool)
}

/**
 * What to tell the person about the form that a save won't refuse, in plain text:
 *
 * - gated tools that don't cover `bash`: a typo, or a list that kept only `pwsh`, and shell commands then run with no gate;
 * - a model that isn't the saved one: the thresholds were set against the old one.
 * @param saved - the settings in the store now, which the model is compared with.
 */
export function formWarnings(form: ThresholdForm, saved: SettingsValues): string[] {
  const warnings: string[] = []
  const gated = toolsOf(form.gated)
  if (!covers(gated, 'bash')) {
    warnings.push(covers(gated, 'pwsh')
      ? 'tools.gated covers pwsh but not bash, so shell commands run through bash are not checked by the judge. If bash is mistyped, fix it before saving.'
      : 'tools.gated covers neither bash nor pwsh, so shell commands run without the judge. If a name is mistyped, fix it before saving.')
  }
  const model = form.model.trim()
  if (model !== '' && model !== saved.model) {
    warnings.push(`You are changing the model from ${saved.model} to ${model}. The thresholds were set against ${saved.model}, so check them against ${model} before relying on them.`)
  }
  return warnings
}
