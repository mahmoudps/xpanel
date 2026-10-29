import type { Account, Domain, Plan, Principal, ServiceUser } from '@xpanel/core'
import { translator, type Locale } from '../../i18n.ts'
import { renderAccountForwarders } from './account-forwarders.ts'
import { renderAccountFilters } from './account-filters.ts'
import { renderAccountMailingLists } from './account-mailing-lists.ts'
import { renderAccountSpamSettings } from './account-spam.ts'
import { renderAccountQuarantine } from './account-quarantine.ts'
import { renderAccountContact } from './account-contact.ts'
import { renderMailxMailToolsWorkspace } from '../mailx-mail-tools-workspace.ts'
import { extensionCard, extensionCollection, extensionDisabled, extensionFact, extensionFrame, extensionText, type ExtensionRouteSpec, type ReadCollection } from './shared.ts'

export const accountPageRouteSpecs: readonly ExtensionRouteSpec[] = [
  { route: '/email/forwarders', surface: 'xpanel', roles: ['owner'], tools: ['forwarders', 'domain-forwarders', 'default-address', 'autoresponders'], title: msgctxt('account-pages', 'Forwarders') },
  { route: '/email/deliverability', surface: 'xpanel', roles: ['owner'], tools: ['email-deliverability', 'email-routing'], title: msgid('Deliverability') },
  { route: '/email/filters', surface: 'xpanel', roles: ['owner'], tools: ['global-email-filters', 'email-filters', 'connect-devices', 'email-disk-usage', 'address-importer'], title: msgid('Email filters') },
  { route: '/email/spam-filters', surface: 'xpanel', roles: ['owner'], tools: ['spam-filters', 'greylisting', 'sender-verification'], title: msgid('Spam filters') },
  { route: '/email/spam-quarantine', surface: 'xpanel', roles: ['owner'], tools: ['spam-quarantine'], title: msgid('Spam quarantine') },
  { route: '/email/mailing-lists', surface: 'xpanel', roles: ['owner'], tools: ['mailing-lists'], title: msgid('Mailing lists') },
  { route: '/email/archive', surface: 'xpanel', roles: ['owner'], tools: ['email-archive'], title: msgid('Email archive') },
  { route: '/email/encryption', surface: 'xpanel', roles: ['owner'], tools: ['email-encryption'], title: msgid('Email encryption') },
  { route: '/email/calendars-contacts', surface: 'xpanel', roles: ['owner'], tools: ['calendars-contacts-management', 'calendars-contacts-sharing', 'calendars-contacts-config'], title: msgid('Calendars and contacts') },
  { route: '/preferences', surface: 'xpanel', roles: ['owner'], tools: ['account-preferences', 'change-style'], title: msgid('Account preferences') },
  { route: '/preferences/language', surface: 'xpanel', roles: ['owner'], tools: ['change-language'], title: msgid('Language') },
  { route: '/preferences/users', surface: 'xpanel', roles: ['owner'], tools: ['user-manager'], title: msgid('Service users') },
  { route: '/preferences/team', surface: 'xpanel', roles: ['owner'], tools: ['manage-team'], title: msgid('Account team') },
  { route: '/health', surface: 'xpanel', roles: ['owner'], tools: ['account-health-overview'], title: msgid('Site health') },
]

/** Entries come from a route-specific authorized read, never from mailbox count. */
export interface AccountCollectionEntry {
  name: string
  address?: string
  destination?: string
}

export interface AccountPagesExtensionInput {
  locale: Locale
  route: string
  principal: Principal
  account: Pick<Account, 'id' | 'planId' | 'status' | 'contactEmail'>
  plan?: Pick<Plan, 'id' | 'caps'>
  theme?: 'light' | 'dark'
  mutationsQualified?: boolean
  domains?: ReadCollection<Pick<Domain, 'accountId' | 'name'>>
  users?: ReadCollection<Pick<ServiceUser, 'accountId' | 'login' | 'services'>>
  collections?: Readonly<Partial<Record<string, ReadCollection<AccountCollectionEntry>>>>
}

const entries = (locale: Locale, value: ReadCollection<AccountCollectionEntry> | undefined): string => extensionCollection(locale, value,
  msgid('The read returned no records.'), item => `<dl class="xp-extension__facts">${extensionFact(locale, msgid('Name'), item.name)}${extensionFact(locale, msgid('Address'), item.address, true)}${extensionFact(locale, msgid('Destination'), item.destination, true)}</dl>`)

export const renderAccountPagesExtension = (input: AccountPagesExtensionInput): string => {
  const { locale, account, principal, route } = input
  const spec = accountPageRouteSpecs.find(item => item.route === route)
  if (!spec || principal.kind !== 'user' || principal.accountId !== account.id || account.status !== 'active') return ''
  const plan = input.plan?.id === account.planId ? input.plan : undefined
  let body: string
  if (route === '/email/forwarders') {
    const domains = input.domains?.state === 'read' ? input.domains.items.filter(domain => domain.accountId === account.id) : []
    const summary = extensionCard(locale, msgid('Account plan'), `<dl class="xp-extension__facts">${extensionFact(locale, msgid('Plan limit'), plan?.caps.forwarders === undefined ? undefined : String(plan.caps.forwarders), true)}</dl>`)
    const mailboxes = input.users?.state === 'read' ? input.users.items.filter(user => user.accountId === account.id && user.services.email).map(user => user.login) : undefined
    return extensionFrame(locale, spec.title, `${summary}${renderAccountForwarders({ lang: locale, domains, canManage: input.mutationsQualified === true && input.domains?.state === 'read',
      ...(mailboxes !== undefined ? { mailboxes } : {}) })}`)
  } else if (route === '/email/filters') {
    const mailboxes = input.users?.state === 'read' ? input.users.items.filter(user => user.accountId === account.id && user.services.email).map(user => ({ login: user.login })) : undefined
    return extensionFrame(locale, spec.title, renderAccountFilters({ lang: locale, expectedAccountId: account.id,
      canManage: input.mutationsQualified === true, ...(mailboxes !== undefined ? { mailboxes } : {}),
    }))
  } else if (route === '/email/spam-filters') {
    return extensionFrame(locale, spec.title, renderAccountSpamSettings({ lang: locale, expectedAccountId: account.id, canManage: input.mutationsQualified === true }) + renderMailxMailToolsWorkspace({ locale, section: 'spam', canManage: input.mutationsQualified === true }))
  } else if (route === '/email/spam-quarantine') {
    const mailboxes = input.users?.state === 'read' ? input.users.items.filter(user => user.accountId === account.id && user.services.email).map(user => user.login) : undefined
    return extensionFrame(locale, spec.title, renderAccountQuarantine({ lang: locale, expectedAccountId: account.id,
      canManage: input.mutationsQualified === true, ...(mailboxes !== undefined ? { mailboxes } : {}),
    }))
  } else if (route === '/email/mailing-lists') {
    const domains = input.domains?.state === 'read' ? input.domains.items.filter(domain => domain.accountId === account.id).map(domain => domain.name) : []
    return extensionFrame(locale, spec.title, renderAccountMailingLists({ lang: locale, expectedAccountId: account.id, canManage: input.mutationsQualified === true && input.domains?.state === 'read', domains }) + renderMailxMailToolsWorkspace({ locale, section: 'lists', canManage: input.mutationsQualified === true }))
  } else if (route === '/preferences') {
    const appearance = extensionCard(locale, msgid('Appearance'), `<dl class="xp-extension__facts">${extensionFact(locale, msgid('Appearance'), input.theme === undefined ? undefined : extensionText(locale, input.theme === 'dark' ? msgid('Dark') : msgid('Light')))}</dl>`)
    return extensionFrame(locale, spec.title, `${renderAccountContact({ lang: locale, expectedAccountId: account.id, canManage: input.mutationsQualified === true })}${appearance}`)
  } else if (route === '/preferences/language') {
    body = `<dl class="xp-extension__facts">${extensionFact(locale, msgid('Current language'), translator(locale)(msgctxt('account-pages', 'English')))}${extensionFact(locale, msgid('Digits'), '0-9', true)}</dl><p>${extensionText(locale, msgid('Use the workspace language control to change the interface language.'))}</p>`
  } else if (route === '/preferences/users') {
    const users = input.users?.state === 'read' ? { state: 'read' as const, items: input.users.items.filter(user => user.accountId === account.id) } : undefined
    body = extensionCollection(locale, users, msgid('The read returned no service users.'), user => `<dl class="xp-extension__facts">${extensionFact(locale, msgid('Login'), user.login, true)}${extensionFact(locale, msgid('Email enabled'), extensionText(locale, user.services.email ? msgid('Yes') : msgid('No')))}</dl>`)
  } else if (route === '/health' || route === '/email/deliverability') {
    const domains = input.domains?.state === 'read' ? { state: 'read' as const, items: input.domains.items.filter(domain => domain.accountId === account.id) } : undefined
    body = `<p data-check-state="unread">${extensionText(locale, msgid('Service check results have not been read. Domain records do not establish DNS, TLS, SMTP or delivery health.'))}</p>${extensionCollection(locale, domains, msgid('The read returned no domains.'), domain => `<dl class="xp-extension__facts">${extensionFact(locale, msgid('Domain'), domain.name, true)}${extensionFact(locale, 'SPF / DKIM / DMARC', extensionText(locale, msgctxt('account-pages', 'Not read')))}${extensionFact(locale, msgid('Service health'), extensionText(locale, msgctxt('account-pages', 'Not read')))}</dl>`)}${extensionDisabled(locale, msgid('Run checks'))}`
  } else {
    const cap = route === '/email/forwarders' ? plan?.caps.forwarders : route === '/email/mailing-lists' ? plan?.caps.mailingLists : undefined
    body = `${route === '/email/forwarders' || route === '/email/mailing-lists' ? `<dl class="xp-extension__facts">${extensionFact(locale, msgid('Plan limit'), cap === undefined ? undefined : String(cap), true)}</dl>` : ''}${entries(locale, input.collections?.[route])}${extensionDisabled(locale, msgid('Manage records'))}`
  }
  return extensionFrame(locale, spec.title, extensionCard(locale, spec.title, body))
}
