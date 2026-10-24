import type { Locale } from '../../i18n.ts'

export type Copy = readonly [english: string, arabic: string]

export type ComposedLayout =
  | 'files'
  | 'site'
  | 'database'
  | 'metrics'
  | 'ssl'
  | 'security'
  | 'php'
  | 'cron'
  | 'editor'
  | 'launch'
  | 'list'
  | 'settings'
  | 'dashboard'
  | 'log'
  | 'wizard'
  | 'matrix'
  | 'terminal'

/** How the product route fills the template. `soon` means no tool is connected. */
export type ComposedBind =
  | 'soon'
  | 'trash'
  | 'ftp'
  | 'webdisk'
  | 'git'
  | 'site-settings'
  | 'ssl-issue'
  | 'ssl-files'
  | 'web-stats'
  | 'terminal'
  | 'panel-usage'
  | 'accounts'
  | 'resellers'
  | 'reseller-acl'
  | 'services'
  | 'ips'
  | 'mail-ips'
  | 'generations'
  | 'backups'
  | 'host-info'
  | 'io'

export interface ComposedRoute {
  route: string
  surface: 'xpanel' | 'xwhm'
  section: string
  group: Copy
  title: Copy
  lede: Copy
  /** Exported board used as the visual template. */
  template: string
  layout: ComposedLayout
  action: Copy | null
  columns: readonly Copy[]
  fields: readonly Copy[]
  bind: ComposedBind
}

export const copyOf = (value: Copy, locale: Locale): string => (locale === 'ar' ? value[1] : value[0])
