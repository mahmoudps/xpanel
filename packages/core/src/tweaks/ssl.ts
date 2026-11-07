import { msgid } from '../i18n/translator.ts'
import type { TweakDefinition } from './index.ts'

/** Tweak Settings of the SSL/TLS section; each key has a real consumer. */
export const SSL_TWEAKS: readonly TweakDefinition[] = [
  // Read by the ~/ssl store routes when a new key, CSR or self-signed certificate names no key type.
  { key: 'ssl.defaultKeyType', label: msgid('Default SSL/TLS key type'), help: msgid('The key type used for new private keys, certificate signing requests and self-signed certificates when none is chosen.'),
    consumer: '/whm/ssl/install', kind: 'choice', default: 'rsa-2048', choices: ['rsa-2048', 'rsa-4096', 'ecdsa-prime256v1', 'ecdsa-secp384r1'] },
]
