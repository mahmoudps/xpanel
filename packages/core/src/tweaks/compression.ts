import { msgid } from '../i18n/translator.ts'
import type { TweakDefinition } from './index.ts'

/** Tweak Settings of the Compression section (cPanel Tweak Settings > Compression); each key has a real consumer. */
export const COMPRESSION_TWEAKS: readonly TweakDefinition[] = [
  { key: 'compression.gzipLevel', label: msgid('gzip compression level'), help: msgid('Level of the gzip streams of server backups, the control snapshot and account transfer packages: 1 is fastest, 9 is smallest.'),
    consumer: '/whm/backups', kind: 'integer', default: 6, min: 1, max: 9, nullable: false },
  // zstd 1-19 without --ultra; 3 on one thread is the measured backup default (docs/decisions/2026-11-06-zstd-backups.md).
  { key: 'compression.zstdLevel', label: msgid('Zstandard compression level'), help: msgid('Level of the Zstandard streams of server backups and the control snapshot: 1 is fastest, 19 is smallest.'),
    consumer: '/whm/backups', kind: 'integer', default: 3, min: 1, max: 19, nullable: false },
]

/** The tweak key that holds the level of each codec the product compresses with. */
export const COMPRESSION_LEVEL_KEY = { gzip: 'compression.gzipLevel', zstd: 'compression.zstdLevel' } as const
