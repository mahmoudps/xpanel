import { catalogText, translator, type Locale } from '../i18n.ts'
import { formatAsciiBytes, formatDisplayDateTime } from '../display-format.ts'
import { canOpenRegisteredRoute, canonicalNavigationRoute, isToolAuthorized, tools as defaultCatalog, visibleNavigation, visibleRegisteredNavigation, visibleTools } from '@xpanel/catalog'
import type { SurfaceAuthority } from './theme-surface.ts'
import type { MailMessageItem, MailSurfaceProps } from '../surfaces/xmail.ts'

const formatMailDateTime = formatDisplayDateTime

export interface MailboxQuotaText {
  text: string
  /** Null when the used/limit ratio was not measured. A zero here would be a fake empty meter. */
  percent: number | null
}

/**
 * `mailboxQuotaMb` is stored under a megabyte name and enforced as `n * 1024 * 1024` bytes
 * (`userdb_quota_rule=*:storage=<n>M`, Dovecot M = 2^20). The label is therefore MiB.
 * Used space is shown only when a measurement was passed in.
 */
const formatQuotaBytes = (bytes: number): string => {
  if (bytes < 1000) return `${new Intl.NumberFormat('en-US').format(Math.round(bytes))} B`
  const kb = bytes / 1000
  const rounded = kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10
  return `${rounded} KB`
}

/** Decoded attachment bytes under 10,000 stay in bytes. Larger files use the decimal byte formatter. */
export const formatAttachmentBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 10_000) return `${new Intl.NumberFormat('en-US').format(Math.round(bytes))} B`
  return formatAsciiBytes(bytes)
}

export const formatMailboxQuota = (
  used: number | undefined,
  limit: number | 'unlimited' | undefined,
  locale: Locale,
  usedBytes?: number,
): MailboxQuotaText => {
  const unlimited = translator(locale)('unlimited')
  const usedKnown = typeof used === 'number' && Number.isFinite(used) && used >= 0
  const limitKnown = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
  const bytesKnown = typeof usedBytes === 'number' && Number.isFinite(usedBytes) && usedBytes >= 0 && usedBytes < 1024 * 1024
  if (bytesKnown && limitKnown) {
    return {
      text: `${formatQuotaBytes(usedBytes)} / ${limit} MiB`,
      percent: Math.max(0, Math.min(100, Math.round((usedBytes / (limit * 1024 * 1024)) * 100))),
    }
  }
  if (usedKnown && limitKnown) {
    return {
      text: `${used} / ${limit} MiB`,
      percent: Math.max(0, Math.min(100, Math.round((used / limit) * 100))),
    }
  }
  if (usedKnown && limit === 'unlimited') return { text: `${used} MiB / ${unlimited}`, percent: null }
  if (usedKnown) return { text: `${used} MiB`, percent: null }
  if (limitKnown) return { text: `— / ${limit} MiB`, percent: null }
  if (limit === 'unlimited') return { text: `— / ${unlimited}`, percent: null }
  return { text: '—', percent: null }
}

/** Labels a UTC instant. A value that is not ISO-8601 is shown unchanged, with no timezone added. */
export const formatMailStamp = (value: string): { time: string; full: string; datetime: string } => {
  const raw = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) || Number.isNaN(Date.parse(raw))) {
    return { time: raw || '—', full: raw || '—', datetime: raw }
  }
  const iso = new Date(raw).toISOString()
  const clock = iso.slice(11, 16)
  const full = formatMailDateTime(raw)
  return { time: `${clock} UTC`, full: full === '—' ? formatMailDateTime(iso) : full, datetime: iso }
}

export const addressList = (value: string | undefined): string[] => {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let angle = false
  for (const ch of value ?? '') {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '<') angle = true
    else if (!quoted && ch === '>') angle = false
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      if (current.trim()) parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts.filter(part => part.includes('@'))
}

export const chipOf = (field: 'to' | 'cc', raw: string): { field: 'to' | 'cc'; name: string; addr: string; invalid: boolean } => {
  const angle = /<([^>]+)>/.exec(raw)
  if (!angle?.[1]) return { field, name: raw, addr: raw, invalid: false }
  const addr = angle[1].trim()
  const name = raw.slice(0, angle.index).trim().replace(/^"(.*)"$/, '$1').trim() || addr
  return { field, name, addr, invalid: false }
}


/** Mailbox facts and permission decisions projected by core; renderers never allocate identities or references. */
export interface MailPageFacts {
  readonly mailbox: string
  readonly route: string
  readonly title: string
  readonly quota: { readonly text: string; readonly percent: number | null }
  readonly folders: readonly MailFolderFacts[]
  readonly customFolders: readonly MailFolderFacts[]
  readonly canCompose: boolean
  readonly actionState?: MailSurfaceProps['actionState']
  readonly folderManageHref?: string
  readonly searchHref?: string
  readonly securityHref?: string
  readonly notice?: { readonly tone: 'info' | 'ok' | 'warn' | 'bad'; readonly title?: string; readonly text: string }
}

export interface MailFolderFacts {
  readonly id: string
  readonly label: string
  readonly href?: string
  readonly current: boolean
  readonly count?: number
}

export interface MailMessageFacts {
  readonly key: string
  readonly uid: number
  readonly fromName: string
  readonly from: string
  readonly to: string
  readonly cc?: string
  readonly subject: string
  readonly preview: string
  readonly datetime: string
  readonly time: string
  readonly fullDate: string
  readonly unread: boolean
  readonly authentication: string
  readonly body: string
  readonly bodyPending: boolean
  readonly attachments: readonly { readonly name: string; readonly size: string }[]
}

export interface MailInboxView extends MailPageFacts {
  readonly kind: 'inbox'
  readonly folder: string
  readonly folderWorkspace: boolean
  readonly state: 'messages' | 'empty' | 'unread' | 'failed'
  readonly messages: readonly MailMessageFacts[]
  readonly selectedKey: string | null
  readonly unreadCount: number | null
  readonly countText: string
  readonly pager: string
  readonly loaded: number
  readonly total: number | null
  readonly moveTargets: readonly { readonly id: string; readonly label: string }[]
  readonly canReadAttachments: boolean
}

export interface MailComposeView extends MailPageFacts {
  readonly kind: 'compose'
  readonly draft: { readonly to: string; readonly cc: string; readonly bcc: string; readonly subject: string; readonly body: string }
  readonly canSend: boolean
  readonly canSaveDraft: boolean
  readonly canUseAttachments: boolean
  readonly canManageVacation: boolean
  readonly identity: { readonly dkim?: string; readonly spf?: string; readonly size?: string }
  readonly vacation: boolean | null
  readonly rules: readonly { readonly name: string; readonly condition: string; readonly action: string; readonly enabled: boolean }[] | null
}

export type MailView = MailInboxView | MailComposeView

/** Exact registered mailbox documents whose data is loaded by their own bounded controllers. */
export const MAIL_WORKSPACE_ROUTES = Object.freeze([
  '/mail/search', '/mail/folders', '/mail/later', '/mail/calendar', '/mail/contacts',
  '/mail/settings/calendars', '/mail/settings/filters', '/mail/settings/spam',
  '/mail/settings/autoresponder', '/mail/settings/forwarders', '/mail/overview',
  '/mail/tools/disk-usage', '/mail/tools/connect-devices', '/mail/tools/track-delivery',
  '/mail/tools/mailing-lists', '/mail/settings/preferences', '/mail/settings/identities',
  '/mail/settings/security',
] as const)

export type MailWorkspaceRoute = typeof MAIL_WORKSPACE_ROUTES[number]

/** These permissions describe current core admission, never a successful provider read or write. */
export interface MailWorkspaceView extends MailPageFacts {
  readonly kind: 'workspace'
  readonly route: MailWorkspaceRoute
  readonly canRead: boolean
  readonly canManage: boolean
  readonly activeFolder: string
  readonly attachmentsAvailable: boolean
  readonly searchAvailable: boolean
  readonly quotaAvailable: boolean
  readonly authorizedRoutes: ReadonlySet<string>
  readonly quotaUsedMb?: number
  readonly quotaUsedBytes?: number
  readonly quotaLimitMb?: number | 'unlimited'
}

export type MailSurfaceView = MailView | MailWorkspaceView

const FOLDER_ROUTES: Readonly<Record<string, string>> = {
  INBOX: '/mail/inbox', Sent: '/mail/sent', Drafts: '/mail/drafts', Trash: '/mail/trash',
}

const STANDARD_FOLDERS = [
  { id: 'INBOX', label: msgid('Inbox') },
  { id: 'Sent', label: msgid('Sent') },
  { id: 'Drafts', label: msgid('Drafts') },
  { id: 'Junk', label: msgctxt('xmail-inbox', 'Junk'), composeLabel: msgctxt('xmail-compose', 'Junk') },
  { id: 'Trash', label: msgctxt('xmail-inbox', 'Trash'), composeLabel: msgctxt('xmail-compose', 'Trash') },
  { id: 'Archive', label: msgid('Archive') },
] as const

const MESSAGE_COUNT = msgid('{count, plural, one {{count} message} other {{count} messages}}')

function mailAccess(props: MailSurfaceProps) {
  const nav = visibleNavigation(props.visibility, props.catalog).find(surface => surface.surface === 'xmail')
  const qualifiedRoutes = new Set(nav?.sections.flatMap(section => section.pages.map(page => page.route)) ?? [])
  const qualified = (href: string) => qualifiedRoutes.has(canonicalNavigationRoute(href))
  const tools = new Set(props.visibility === undefined ? [] : visibleTools(props.catalog ?? defaultCatalog, props.visibility)
    .filter(tool => tool.surface === 'xmail').map(tool => tool.id))
  return { nav, qualifiedRoutes, qualified, tools }
}

function mailPageFacts(
  props: MailSurfaceProps & { readonly mailbox: string },
  access: ReturnType<typeof mailAccess>,
  options: { readonly route: string; readonly folder: string; readonly compose: boolean; readonly observed: boolean; readonly messages: readonly MailMessageItem[]; readonly title?: string; readonly folderCurrent?: boolean },
): MailPageFacts {
  const { route, folder, compose, observed, messages } = options
  const locale = props.locale ?? 'en'
  const t = translator(locale)
  const current = options.folderCurrent !== false && !compose
  const folders: MailFolderFacts[] = STANDARD_FOLDERS.map(item => {
    const measured = props.folderCounts?.find(row => row.folder === item.id)
    const count = measured ? item.id === 'INBOX' ? measured.unread : measured.total
      : observed ? messages.filter(message => message.folder === item.id && (item.id !== 'INBOX' || message.unread)).length : undefined
    const href = FOLDER_ROUTES[item.id] ?? `/mail/inbox?folder=${encodeURIComponent(item.id)}`
    const label = t(compose && 'composeLabel' in item ? item.composeLabel : item.label)
    return { id: item.id, label, current: current && item.id === folder, ...(access.qualified(href.split('?')[0]!) ? { href } : {}), ...(count === undefined ? {} : { count }) }
  })
  const standardIds = new Set<string>(STANDARD_FOLDERS.map(item => item.id))
  const observedFolders = [...new Set(messages.map(message => message.folder).filter(value => value !== 'INBOX'))]
  if (!compose && !standardIds.has(folder) && !observedFolders.includes(folder)) observedFolders.push(folder)
  const customFolders: MailFolderFacts[] = observedFolders.filter(id => !standardIds.has(id)).map(id => ({
    id, label: id, current: current && id === folder,
    ...(access.qualified('/mail/inbox') ? { href: `/mail/inbox?folder=${encodeURIComponent(id)}` } : {}),
  }))
  return {
    mailbox: props.mailbox, route, title: options.title ?? (compose ? t('Compose message') : folders.find(item => item.id === folder)?.label ?? folder),
    quota: formatMailboxQuota(props.quotaUsedMb, props.quotaLimitMb, locale, props.quotaUsedBytes),
    folders, customFolders, canCompose: access.qualified('/mail/compose'),
    ...(access.qualified('/mail/folders') ? { folderManageHref: '/mail/folders' } : {}),
    ...(access.qualified('/mail/search') && access.tools.has('webmail-search') ? { searchHref: '/mail/search' } : {}),
    ...(access.qualified('/mail/settings/security') ? { securityHref: '/mail/settings/security' } : {}),
    ...(props.actionState ? { actionState: props.actionState } : {}),
  }
}

function messageFacts(message: MailMessageItem, locale: Locale): MailMessageFacts {
  const stamp = formatMailStamp(message.receivedAt)
  const word = (value: boolean | undefined) => value === undefined ? translator(locale)('not checked') : value ? 'pass' : 'fail'
  return {
    key: `uid-${message.uid}`, uid: message.uid,
    fromName: message.fromName?.trim() || message.from, from: message.from, to: message.to,
    cc: message.cc ?? '', subject: message.subject, preview: message.preview,
    datetime: stamp.datetime, time: stamp.time, fullDate: stamp.full, unread: message.unread,
    authentication: `DKIM: ${word(message.dkimPass)} · SPF: ${word(message.spfPass)} · DMARC: ${word(message.dmarcPass)}`,
    body: message.body, bodyPending: message.bodyPending === true && message.body.length === 0,
    attachments: (message.attachments ?? []).filter(file => file.name.trim().length > 0)
      .map(file => ({ name: file.name, size: formatAttachmentBytes(file.sizeBytes) })),
  }
}

/** Projects only the supported mailbox documents. Core routing handles other pages and unavailable capabilities. */
export function projectMailView(props: MailSurfaceProps): MailView | undefined {
  if (!props.mailbox) return undefined
  const route = props.activeRoute === '/mail' ? '/mail/inbox' : props.activeRoute ?? '/mail/inbox'
  const compose = route === '/mail/compose'
  const routeFolder = Object.entries(FOLDER_ROUTES).find(([, href]) => href === route)?.[0]
  if (!compose && routeFolder === undefined) return undefined
  const access = mailAccess(props)
  if (!access.qualified(route)) return undefined
  return projectMailPrimaryFacts({ ...props, mailbox: props.mailbox }, access, route)
}

function projectMailPrimaryFacts(props: MailSurfaceProps & { readonly mailbox: string }, access: ReturnType<typeof mailAccess>, route: string): MailView {
  const compose = route === '/mail/compose'
  const routeFolder = Object.entries(FOLDER_ROUTES).find(([, href]) => href === route)?.[0]
  const locale = props.locale ?? 'en', t = translator(locale), tools = access.tools
  const folder = route === '/mail/inbox' ? props.activeFolder || 'INBOX' : routeFolder ?? 'INBOX'
  const folderWorkspace = !compose && Object.hasOwn(FOLDER_ROUTES, folder)
  const observed = props.messages !== undefined && (route === '/mail/inbox' || compose || props.activeFolder === folder)
  const messages = observed ? (props.messages ?? []).filter(message => Number.isSafeInteger(message.uid) && message.uid > 0) : []
  const common = mailPageFacts({ ...props, mailbox: props.mailbox }, access, { route, folder, compose, observed, messages })
  const { folders, customFolders } = common
  if (compose) return {
    ...common, kind: 'compose', draft: { to: props.composeDraft?.to ?? '', cc: props.composeDraft?.cc ?? '', bcc: '', subject: props.composeDraft?.subject ?? '', body: props.composeDraft?.body ?? '' },
    canSend: common.canCompose, canSaveDraft: common.canCompose,
    canUseAttachments: tools.has('webmail-attachments'), canManageVacation: tools.has('webmail-autoresponder'),
    identity: { ...(props.identityDkim ? { dkim: props.identityDkim } : {}), ...(props.identitySpf ? { spf: props.identitySpf } : {}), ...(props.identitySize ? { size: props.identitySize } : {}) },
    vacation: props.vacationEnabled ?? null,
    rules: props.sieveRules?.map(rule => ({ name: rule.name, condition: rule.condition, action: rule.action, enabled: rule.enabled })) ?? null,
  }
  const visible = messages.filter(message => message.folder === folder)
  const selected = visible.find(message => message.uid === props.selectedUid) ?? visible[0]
  const unread = visible.filter(message => message.unread).length
  const state = observed ? visible.length === 0 ? 'empty' : 'messages' : props.mailListFailed ? 'failed' : 'unread'
  return {
    ...common, kind: 'inbox', folder, folderWorkspace, state,
    messages: visible.map(message => messageFacts(message, locale)), selectedKey: selected ? `uid-${selected.uid}` : null,
    unreadCount: observed ? unread : null,
    countText: state === 'empty' ? t('0 messages') : state === 'messages'
      ? `${t(MESSAGE_COUNT, { count: visible.length })}${unread ? ` · ${t('{count} unread', { count: unread })}` : ''}` : '—',
    pager: state === 'empty' ? t('0 of 0') : state === 'messages' ? t('1–{shown} of {total}', { shown: visible.length, total: visible.length }) : '—',
    loaded: visible.length, total: observed ? visible.length : null,
    moveTargets: [...folders, ...customFolders].filter(item => !item.current && (folderWorkspace || item.id !== 'INBOX')).map(item => ({ id: item.id, label: item.label })),
    canReadAttachments: tools.has('webmail-message-read') && tools.has('webmail-attachments'),
  }
}

/** Theme-neutral projection for all registered mailbox documents, with independent search admission. */
export function projectMailSurfaceView(props: MailSurfaceProps): MailSurfaceView | undefined {
  const primary = projectMailView(props)
  if (primary !== undefined) return primary
  if (!props.mailbox || !MAIL_WORKSPACE_ROUTES.includes(props.activeRoute as MailWorkspaceRoute)) return undefined
  const route = props.activeRoute as MailWorkspaceRoute
  const access = mailAccess(props)
  if (!access.qualified(route) || (route === '/mail/search' && !access.tools.has('webmail-search'))) return undefined
  const page = access.nav?.sections.flatMap(section => section.pages).find(item => item.route === route)
  const locale = props.locale ?? 'en'
  const title = route === '/mail/search' ? translator(locale)('Search mail')
    : page ? catalogText(locale, `nav.page.xmail.${page.id}.name`, page.name) : ''
  const folder = props.activeFolder || 'INBOX'
  const authorizedRoutes = new Set([
    ...access.qualifiedRoutes,
    ...Object.values(FOLDER_ROUTES).filter(value => access.qualified(value)),
    ...(access.qualified('/mail/search') && access.tools.has('webmail-search') ? ['/mail/search'] : []),
  ])
  const common = mailPageFacts({ ...props, mailbox: props.mailbox }, access, { route, folder, compose: false, observed: false, messages: [], title, folderCurrent: false })
  return {
    ...common, kind: 'workspace', route, canRead: true, canManage: true, activeFolder: folder,
    attachmentsAvailable: access.tools.has('webmail-message-read') && access.tools.has('webmail-attachments'),
    searchAvailable: access.tools.has('webmail-search'), quotaAvailable: access.tools.has('webmail-disk-cleanup'), authorizedRoutes,
    ...(props.quotaUsedMb === undefined ? {} : { quotaUsedMb: props.quotaUsedMb }),
    ...(props.quotaUsedBytes === undefined ? {} : { quotaUsedBytes: props.quotaUsedBytes }),
    ...(props.quotaLimitMb === undefined ? {} : { quotaLimitMb: props.quotaLimitMb }),
  }
}


export type ReadOnlyMailPresentation = MailSurfaceView & {
  readonly readOnly: true
  readonly canReadFacts: boolean
  readonly canRead: false
  readonly canManage: false
}

/** Stored mailbox observations remain independently authorized; this projection grants no native operation. */
export function projectReadOnlyMailSurfaceView(props: MailSurfaceProps, authority: SurfaceAuthority): ReadOnlyMailPresentation | undefined {
  const visibility = props.visibility
  const route = props.activeRoute === '/mail' ? '/mail/inbox' : props.activeRoute ?? '/mail/inbox'
  if (authority.presentation !== 'read-only' || visibility?.principal.kind !== 'user' || !canOpenRegisteredRoute(route, visibility)) return undefined
  const primary = route === '/mail/compose' || Object.values(FOLDER_ROUTES).includes(route)
  if (!primary && !MAIL_WORKSPACE_ROUTES.includes(route as MailWorkspaceRoute)) return undefined
  const catalog = props.catalog ?? defaultCatalog
  const granted = new Set(catalog.filter(tool => tool.surface === 'xmail' && authority.authorizedTools.has(tool.id) && isToolAuthorized(tool, visibility)).map(tool => tool.id))
  const known = authority.canReadFacts && !!props.mailbox
  const can = (id: string) => known && granted.has(id)
  const listing = can('webmail-message-list'), reading = can('webmail-message-read'), attachments = reading && can('webmail-attachments')
  const quota = can('webmail-disk-cleanup'), compose = can('webmail-compose'), identity = can('webmail-identities')
  const scoped: MailSurfaceProps & { mailbox: string } = {
    ...props, mailbox: props.mailbox ?? '',
    messages: listing ? props.messages?.map(message => ({ ...message,
      body: reading ? message.body : '', bodyPending: reading ? message.bodyPending : true,
      attachments: attachments ? message.attachments : undefined,
      dkimPass: reading ? message.dkimPass : undefined, spfPass: reading ? message.spfPass : undefined, dmarcPass: reading ? message.dmarcPass : undefined,
    })) : undefined,
    folderCounts: listing ? props.folderCounts : undefined,
    mailListFailed: listing ? props.mailListFailed : undefined,
    selectedUid: reading ? props.selectedUid : undefined,
    quotaUsedMb: quota ? props.quotaUsedMb : undefined, quotaUsedBytes: quota ? props.quotaUsedBytes : undefined, quotaLimitMb: quota ? props.quotaLimitMb : undefined,
    composeDraft: compose ? props.composeDraft : undefined,
    identityDkim: identity ? props.identityDkim : undefined, identitySpf: identity ? props.identitySpf : undefined, identitySize: identity ? props.identitySize : undefined,
    vacationEnabled: can('webmail-autoresponder') ? props.vacationEnabled : undefined,
    sieveRules: can('webmail-email-filters') ? props.sieveRules : undefined,
  }
  const nav = visibleRegisteredNavigation(visibility).find(surface => surface.surface === 'xmail')
  const pages = nav?.sections.flatMap(section => section.pages) ?? []
  const routes = new Set(pages.filter(page => page.tools.some(id => granted.has(id))).map(page => page.route))
  const access: ReturnType<typeof mailAccess> = { nav, qualifiedRoutes: routes, tools: granted, qualified: href => routes.has(canonicalNavigationRoute(href)) }
  const flags = { readOnly: true as const, canReadFacts: known, canRead: false as const, canManage: false as const, canCompose: false }
  if (primary) {
    const view = projectMailPrimaryFacts(scoped, access, route)
    return view.kind === 'compose'
      ? { ...view, ...flags, canSend: false, canSaveDraft: false, canUseAttachments: false, canManageVacation: false }
      : { ...view, ...flags, canReadAttachments: false, moveTargets: [] }
  }
  const page = pages.find(item => item.route === canonicalNavigationRoute(route))
  const locale = props.locale ?? 'en'
  const title = route === '/mail/search' ? translator(locale)('Search mail') : page ? catalogText(locale, 'nav.page.xmail.' + page.id + '.name', page.name) : ''
  const common = mailPageFacts(scoped, access, { route, folder: props.activeFolder || 'INBOX', compose: false, observed: false, messages: [], title, folderCurrent: false })
  return { ...common, ...flags, kind: 'workspace', route: route as MailWorkspaceRoute,
    activeFolder: props.activeFolder || 'INBOX', attachmentsAvailable: false, searchAvailable: false, quotaAvailable: false, authorizedRoutes: routes,
    ...(scoped.quotaUsedMb === undefined ? {} : { quotaUsedMb: scoped.quotaUsedMb }),
    ...(scoped.quotaUsedBytes === undefined ? {} : { quotaUsedBytes: scoped.quotaUsedBytes }),
    ...(scoped.quotaLimitMb === undefined ? {} : { quotaLimitMb: scoped.quotaLimitMb }),
  }
}
