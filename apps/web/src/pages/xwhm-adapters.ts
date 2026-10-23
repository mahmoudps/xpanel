/** One wiring point per xWHM page. A disabled action stays on the page as coming soon. */

export interface WiredPageAction {
  enabled: true
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
}

export interface DisabledPageAction {
  enabled: false
  hint: { en: string; ar: string }
}

export type PageAction = WiredPageAction | DisabledPageAction

const soon: DisabledPageAction = { enabled: false, hint: { en: 'Coming soon', ar: 'قيد التفعيل' } }

export const xwhmPageAdapters = {
  resellers: {
    route: '/whm/resellers',
    toolIds: ['reseller-center'],
    create: { enabled: true, method: 'POST', path: '/api/resellers' },
    usage: soon,
  },
  dns: {
    route: '/whm/dns',
    toolIds: ['dns-zone-manager', 'add-dns-zone', 'delete-dns-zone'],
    list: { enabled: true, method: 'GET', path: '/api/dns/zones' },
    save: { enabled: true, method: 'PUT', path: '/api/dns/zones/' },
    remove: { enabled: true, method: 'DELETE', path: '/api/dns/zones/' },
    bulkTtl: soon,
  },
  backups: {
    route: '/whm/backups/restore',
    toolIds: ['backup-restoration'],
    listPrefix: '/api/backups/accounts/',
    create: { enabled: true, method: 'POST', path: '/api/backups/accounts/' },
    schedule: soon,
  },
  services: {
    route: '/whm/services',
    toolIds: ['restart-web', 'restart-mysql', 'restart-mta', 'restart-imap', 'restart-ftp', 'restart-dns'],
    list: { enabled: true, method: 'GET', path: '/api/server/services' },
    restartPrefix: '/api/server/services/',
    restartSuffix: '/restart',
    reboot: soon,
  },
  serverInfo: {
    route: '/whm/monitoring/server-info',
    toolIds: ['server-information'],
    read: { enabled: true, method: 'GET', path: '/api/server/info' },
    benchmark: soon,
  },
  dashboard: {
    route: '/whm',
    toolIds: ['server-information'],
    info: { enabled: true, method: 'GET', path: '/api/server/info' },
    services: { enabled: true, method: 'GET', path: '/api/server/services' },
    drift: { enabled: true, method: 'GET', path: '/api/server/drift' },
    audit: { enabled: true, method: 'GET', path: '/api/audit?limit=8' },
  },
} as const
