import { type Locale, translator } from '../../i18n.ts'
export type Copy = string
export type ComposedLayout = 'files' | 'site' | 'database' | 'metrics' | 'ssl' | 'security' | 'php' | 'cron' | 'editor' | 'launch' | 'list' | 'settings' | 'dashboard' | 'log' | 'wizard' | 'matrix' | 'terminal'
export type ComposedBind = 'soon' | 'trash' | 'ftp' | 'webdisk' | 'git' | 'site-settings' | 'ssl-issue' | 'ssl-files' | 'web-stats' | 'terminal' | 'panel-usage' | 'accounts' | 'resellers' | 'reseller-acl' | 'services' | 'ips' | 'mail-ips' | 'generations' | 'backups' | 'host-info' | 'io'

export interface ComposedRoute {
  route: string
  surface: 'xpanel' | 'xwhm'
  section: string
  group: Copy
  title: Copy
  lede: Copy
  layout: ComposedLayout
  action: Copy | null
  columns: readonly Copy[]
  fields: readonly Copy[]
  bind: ComposedBind
}

export const copyOf = (value: Copy, locale: Locale): string => translator(locale)(value)
