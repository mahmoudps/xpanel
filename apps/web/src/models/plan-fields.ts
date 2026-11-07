import { PLAN_CAP_RULES, RESOURCE_RULES, type Plan } from '@xpanel/core'

type Copy = string
export type Field = { key: string; id: string; label: Copy; min: number; max: number; scale: number }

const resourceLabels: Record<keyof Plan['resources'], Copy> = {
  diskMb: msgid('Disk (MiB)'), bandwidthMbMonth: msgid('Monthly bandwidth (MiB)'),
  ioReadBps: msgid('Disk read (MiB/s)'), ioWriteBps: msgid('Disk write (MiB/s)'),
  ioReadIops: msgid('Read operations per second'), ioWriteIops: msgid('Write operations per second'),
  memoryMb: msgid('Memory (MiB)'), maxProcesses: msgid('Processes'), cpuPercent: msgid('CPU (%)'),
}
const capLabels: Record<keyof Plan['caps'], Copy> = {
  addonDomains: msgid('Addon domains'), aliasDomains: msgid('Alias domains'),
  subdomains: msgid('Subdomains'), mailboxes: msgid('Mailboxes'), forwarders: msgid('Forwarders'),
  mailingLists: msgid('Mailing lists'), ftpAccounts: msgid('FTP accounts'), databases: msgid('Databases'),
  phpWorkers: msgid('PHP workers'),
}
const ids: Record<string, string> = { cpuPercent: 'plan-cpu-quota', memoryMb: 'plan-memory-max', maxProcesses: 'plan-tasks-max' }
export const PLAN_RESOURCE_FIELDS: readonly Field[] = Object.entries(RESOURCE_RULES).map(([key, rule]) => ({
  key, id: ids[key] ?? `plan-${key}`, label: resourceLabels[key as keyof Plan['resources']], min: rule.min, max: rule.max,
  scale: key === 'ioReadBps' || key === 'ioWriteBps' ? 1024 * 1024 : 1,
}))
export const PLAN_CAP_FIELDS: readonly Field[] = Object.entries(PLAN_CAP_RULES).map(([key, rule]) => ({
  key, id: `plan-${key}`, label: capLabels[key as keyof Plan['caps']], min: rule.min, max: rule.max, scale: 1,
}))
/** The remaining WHM Modify Account limits; disk and bandwidth keep their own tools. */
export const ACCOUNT_PACKAGE_LIMIT_FIELDS = [...PLAN_RESOURCE_FIELDS.filter(field => !['diskMb', 'bandwidthMbMonth'].includes(field.key)).map(field => ({ ...field, group: 'resources' as const })), ...PLAN_CAP_FIELDS.map(field => ({ ...field, group: 'caps' as const }))]
