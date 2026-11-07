// The DNSSEC form choices both themes offer.
import '../i18n.ts'

export const DNSSEC_ALGORITHM_CHOICES: readonly (readonly [string, string])[] = [
  ['ecdsa256', msgid('ECDSA P-256 (13, recommended)')], ['ed25519', msgid('Ed25519 (15)')], ['ecdsa384', msgid('ECDSA P-384 (14)')],
  ['rsasha256', msgid('RSA/SHA-256 (8)')], ['rsasha512', msgid('RSA/SHA-512 (10)')],
]
export const DNSSEC_LAYOUT_CHOICES: readonly (readonly [string, string])[] = [['csk', msgid('One combined signing key (CSK)')], ['split', msgid('Separate KSK and ZSK')]]
export const DNSSEC_NSEC_CHOICES: readonly (readonly [string, string])[] = [['nsec', 'NSEC'], ['nsec3', 'NSEC3'], ['nsec3-optout', msgid('NSEC3 with opt-out')]]
export const DNSSEC_KEY_TYPE_CHOICES: readonly (readonly [string, string])[] = [['zsk', msgid('Zone signing key (ZSK)')], ['ksk', msgid('Key signing key (KSK)')]]
