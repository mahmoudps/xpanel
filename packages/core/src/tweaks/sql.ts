import { msgid } from '../i18n/translator.ts'
import type { TweakDefinition } from './index.ts'

/** Tweak Settings of the SQL section; each key has a real consumer, the rendered MariaDB server drop-in. */
export const SQL_TWEAKS: readonly TweakDefinition[] = [
  { key: 'sql.autotuneLimits', label: msgid('Set open_files_limit and max_allowed_packet'), help: msgid('Writes the server values for open files and the largest packet to the xPanel MariaDB configuration file.'),
    consumer: '/whm/databases/servers', kind: 'boolean', default: true },
  { key: 'sql.innodbBufferPoolByRam', label: msgid('Size the InnoDB buffer pool from server memory'), help: msgid('Sets innodb_buffer_pool_size to a quarter of server memory, at least 128 MiB. Off keeps the MariaDB default.'),
    consumer: '/whm/databases/servers', kind: 'boolean', default: false },
  { key: 'sql.slowQueryLog', label: msgid('Record slow queries'), help: msgid('Writes statements that run past the threshold to the MariaDB slow query log, read on the Logs page.'),
    consumer: '/whm/monitoring/logs', kind: 'boolean', default: false },
  { key: 'sql.longQueryTime', label: msgid('Slow query threshold (seconds)'), help: msgid('A statement that runs at least this long is recorded while slow query recording is on.'),
    consumer: '/whm/monitoring/logs', kind: 'integer', default: 2, min: 1, max: 600, nullable: false },
]
