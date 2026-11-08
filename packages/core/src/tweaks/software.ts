import { msgid } from '../i18n/translator.ts'
import type { TweakDefinition, TweakValue } from './index.ts'

/** Tweak Settings of the Software section; each key has a real consumer. */
export const SOFTWARE_TWEAKS: readonly TweakDefinition[] = [
  // Read by the nightly maintenance run (apps/agent/src/svc-nightly.ts).
  { key: 'software.nightlyPackageCheck', label: msgid('Nightly panel file check'), help: msgid('Each night the installed panel files are compared with the SHA-256 digests in the release manifest. The result is shown on this page.'), consumer: '/whm/panel/settings', kind: 'boolean', default: true },
]

export const nightlyPackageCheck = (values: Readonly<Record<string, TweakValue>>): boolean => values['software.nightlyPackageCheck'] !== false
