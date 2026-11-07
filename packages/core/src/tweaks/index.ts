import { fail } from '../errors.ts'
import { COMPRESSION_TWEAKS } from './compression.ts'
import { DOMAIN_TWEAKS } from './domains.ts'
import { LOG_TWEAKS } from './logs.ts'
import { LOGGING_TWEAKS } from './logging.ts'
import { SECURITY_TWEAKS } from './security.ts'
import { PACKAGE_TWEAKS } from './packages.ts'
import { REDIRECTION_TWEAKS } from './redirection.ts'
import { SERVER_TWEAKS } from './server.ts'
import { SOFTWARE_TWEAKS } from './software.ts'
import { SSL_TWEAKS } from './ssl.ts'
import { SQL_TWEAKS } from './sql.ts'
import { STATUS_TWEAKS } from './status.ts'
import { SUPPORT_TWEAKS } from './support.ts'

/** Saved Tweak Settings values below the state root: one JSON object of key to value. */
export const TWEAK_SETTINGS_STATE = 'extended/server/tweak-settings.json'

interface TweakBase {
  /** unique dotted key; the part before the first dot names its section, e.g. 'ssl.defaultKeyType' */
  key: string
  /** msgid of the label */
  label: string
  /** msgid of the help text */
  help: string
  /** route of the page whose behaviour the value changes, listed by the settings browser */
  consumer: string
}

export type TweakDefinition = TweakBase & (
  | { kind: 'boolean'; default: boolean }
  | { kind: 'integer'; default: number | null; min: number; max: number; /** null switches the setting off */ nullable: boolean }
  | { kind: 'choice'; default: string; choices: readonly string[] }
  /** an https address, or empty for none */
  | { kind: 'url'; default: '' }
)

export type TweakValue = boolean | number | string | null

export const TWEAKS: readonly TweakDefinition[] = [...LOG_TWEAKS, ...SERVER_TWEAKS, ...COMPRESSION_TWEAKS, ...SSL_TWEAKS, ...SQL_TWEAKS, ...DOMAIN_TWEAKS, ...LOGGING_TWEAKS, ...SECURITY_TWEAKS, ...STATUS_TWEAKS, ...SUPPORT_TWEAKS, ...SOFTWARE_TWEAKS, ...PACKAGE_TWEAKS, ...REDIRECTION_TWEAKS]
export { COMPRESSION_LEVEL_KEY } from './compression.ts'
export { assertDomainTweaks, zoneDefaultsFromTweaks } from './domains.ts'

const tweakUrl = (v: string): boolean => {
  if (v.length > 512 || /[\s\p{Cc}]/u.test(v)) return false
  try { return new URL(v).protocol === 'https:' } catch { return false }
}

const valueOf = (d: TweakDefinition, v: unknown): TweakValue => {
  const ok = d.kind === 'boolean' ? typeof v === 'boolean'
    : d.kind === 'integer' ? (v === null && d.nullable) || (typeof v === 'number' && Number.isInteger(v) && v >= d.min && v <= d.max)
      : d.kind === 'choice' ? typeof v === 'string' && d.choices.includes(v)
        : typeof v === 'string' && (v === '' || tweakUrl(v))
  return ok ? v as TweakValue : fail('VALIDATION', 'tweak setting value is outside its definition', { key: d.key })
}

/** Every defined key with its saved value or its default; `raw` null means nothing is saved. Unknown keys are refused, never dropped. */
export const parseTweakValues = (raw: unknown, definitions: readonly TweakDefinition[] = TWEAKS): Record<string, TweakValue> => {
  if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) return fail('VALIDATION', 'tweak settings must be an object of key to value')
  const saved = (raw ?? {}) as Record<string, unknown>
  const known = new Set(definitions.map((d) => d.key))
  const unknown = Object.keys(saved).find((key) => !known.has(key))
  if (unknown !== undefined) fail('VALIDATION', 'unknown tweak setting', { key: unknown.slice(0, 64) })
  return Object.fromEntries(definitions.map((d) => [d.key, Object.hasOwn(saved, d.key) ? valueOf(d, saved[d.key]) : d.default]))
}
