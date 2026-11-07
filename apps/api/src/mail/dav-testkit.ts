import { createHash } from 'node:crypto'
import type { WebmailCalendar, WebmailContact } from '../extended-routes.ts'
import type { DavExchange, DavExchangeInput, DavExchangeReply } from './dav-store.ts'
import { parseDavContact, renderDavEvent } from './dav-store.ts'

/** An in-memory store with the launcher's and Radicale's observable behaviour, for API tests without a host. */
interface Item { text: string; etag: string }
interface Collection { props: Record<string, string>; items: Map<string, Item> }
type Account = Map<string, Map<string, Collection>>
const etagOf = (text: string): string => '"' + createHash('sha256').update(text).digest('hex') + '"'
const unescape = (value: string): string => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
const KEYS: Readonly<Record<string, string>> = { 'D:displayname': 'D:displayname', 'I:calendar-color': 'ICAL:calendar-color', 'C:calendar-description': 'C:calendar-description', 'CR:addressbook-description': 'CR:addressbook-description' }
const propsOf = (xml: string): Record<string, string> => {
  const props: Record<string, string> = {}
  for (const match of xml.matchAll(/<((?:D|I|C|CR|X):[a-z-]+)>([^<]*)<\/\1>/g)) props[KEYS[match[1]!] ?? '{urn:xpanel:dav}' + match[1]!.slice(2)] = unescape(match[2]!)
  return props
}

export interface MemoryDav {
  exchange: DavExchange
  /** what a device sees and writes: the stored item text */
  item(username: string, principal: string, collection: string, href: string): string | undefined
  put(username: string, principal: string, collection: string, href: string, text: string): void
  collections(username: string, principal: string): string[]
  requests: DavExchangeInput[]
  /** the next store request, or the next with this method, fails like a stopped server */
  failNext(status?: number, method?: DavExchangeInput['method']): void
  /** The whole store as text: equal before and after means nothing changed. */
  snapshot(): string
  /** Every contact in the store, as a device would read it. */
  contacts(): (NonNullable<ReturnType<typeof parseDavContact>> & { id: string; principal: string })[]
  /** The fixtures of record-shaped tests; `usernameOf` places a record in its account. */
  seedContacts(records: readonly Seeded<WebmailContact>[], usernameOf: (accountId: string) => string): void
  seedCalendars(records: readonly Seeded<WebmailCalendar>[], usernameOf: (accountId: string) => string): void
  seedGroups(username: string, principal: string, groups: readonly { name: string; createdAt: string | null }[]): void
  /** The mailbox's stored group definitions as text, or null before any were written. */
  groups(username: string, principal: string): string | null
  /** Store reads report this many items no page can hold. */
  omit(count: number): void
  /** The next write stops at the store until `release`, holding its mailbox's lock. */
  pauseNextWrite(): { reached: Promise<void>; release(): void }
}
type Seeded<T> = Omit<T, 'ownerAuthority'> & { ownerAuthority?: { accountId: string; serviceUserId: string; mailbox?: string } | undefined }

export const createMemoryDav = (options: { defaults?: boolean; pageBytes?: number } = {}): MemoryDav => {
  const accounts = new Map<string, Account>()
  const requests: DavExchangeInput[] = []
  let omitted = 0
  let failing: { status: number; method: string | undefined } | null = null
  let pause: { arrived: () => void; gate: Promise<void> } | null = null
  const principalOf = (username: string, principal: string): Map<string, Collection> => {
    const account = accounts.get(username) ?? new Map<string, Map<string, Collection>>()
    accounts.set(username, account)
    let collections = account.get(principal)
    if (!collections) { collections = new Map(); account.set(principal, collections) }
    if (!collections.has('addressbook')) collections.set('addressbook', { props: { tag: 'VADDRESSBOOK', 'D:displayname': 'Contacts' }, items: new Map() })
    if (options.defaults && !collections.has('calendar')) collections.set('calendar', { props: { tag: 'VCALENDAR', 'D:displayname': 'Calendar', 'C:supported-calendar-component-set': 'VEVENT,VTODO,VJOURNAL' }, items: new Map() })
    return collections
  }
  const reply = (status: number, body = '', etag: string | null = null): DavExchangeReply => ({ status, body, etag })
  const exchange: DavExchange = async (_caller, account, input) => {
    requests.push(input)
    if (failing && (!failing.method || failing.method === input.method)) { const { status } = failing; failing = null; return reply(status) }
    if (pause && input.method !== 'GET') { const { arrived, gate } = pause; pause = null; arrived(); await gate }
    const own = principalOf(account.username, input.principal)
    if (input.method === 'GET' && input.path.startsWith('/.xpanel/store')) {
      const skip = Number(Buffer.from(input.path.split('?after=')[1] ?? '', 'hex').toString() || 0), collections: unknown[] = []
      let index = 0, room = options.pageBytes ?? 6 * 1024 * 1024
      for (const [owner, list] of accounts.get(account.username) ?? []) for (const [name, collection] of list) {
        if (owner !== input.principal && !(collection.props['{urn:xpanel:dav}grantees'] ?? '').split(',').includes(input.principal)) continue
        const items: { href: string; text: string }[] = []
        collections.push({ owner, name, props: collection.props, items })
        for (const [href, item] of collection.items) {
          if (index++ < skip) continue
          if (Buffer.byteLength(item.text, 'utf8') > room) return reply(200, JSON.stringify({ collections, omitted, next: Buffer.from(String(index - 1)).toString('hex') }))
          room -= Buffer.byteLength(item.text, 'utf8')
          items.push({ href, text: item.text })
        }
      }
      return reply(200, JSON.stringify({ collections, omitted, next: null }))
    }
    const [, , encodedCollection, encodedItem] = input.path.split('/')
    const name = decodeURIComponent(encodedCollection!), href = encodedItem ? decodeURIComponent(encodedItem) : ''
    const collection = own.get(name)
    if (input.method === 'MKCALENDAR' || input.method === 'MKCOL') {
      if (collection) return reply(409)
      const tag = input.method === 'MKCOL' ? 'VADDRESSBOOK' : 'VCALENDAR'
      const component = /<C:comp name="([A-Z]+)"\/>/.exec(input.body ?? '')?.[1]
      own.set(name, { props: { tag, ...(component ? { 'C:supported-calendar-component-set': component } : {}), ...propsOf(input.body ?? '') }, items: new Map() })
      return reply(201)
    }
    if (!collection) return reply(404)
    if (input.method === 'PROPPATCH') { Object.assign(collection.props, propsOf(input.body ?? '')); return reply(207) }
    if (input.method === 'DELETE' && !href) {
      if (name === 'calendar' || name === 'addressbook') return reply(403)
      own.delete(name)
      return reply(200)
    }
    const item = collection.items.get(href)
    if (input.method === 'GET') return item ? reply(200, item.text, item.etag) : reply(404)
    if (input.method === 'DELETE') { if (!item) return reply(404); collection.items.delete(href); return reply(200) }
    if (input.ifNoneMatch && item) return reply(412)
    if (input.ifMatch && item?.etag !== input.ifMatch) return reply(412)
    const text = input.body ?? ''
    collection.items.set(href, { text, etag: etagOf(text) })
    return reply(item ? 200 : 201)
  }
  return {
    exchange, requests,
    item: (username, principal, collection, href) => principalOf(username, principal).get(collection)?.items.get(href)?.text,
    put: (username, principal, collection, href, text) => { principalOf(username, principal).get(collection)!.items.set(href, { text, etag: etagOf(text) }) },
    collections: (username, principal) => [...principalOf(username, principal).keys()],
    failNext: (status = 503, method) => { failing = { status, method } },
    // A first request creates a principal's default collections; those alone are not a change.
    snapshot: () => JSON.stringify([...accounts].flatMap(([username, account]) => [...account].flatMap(([principal, collections]) => [...collections].flatMap(([name, collection]) =>
      collection.items.size || Object.keys(collection.props).some(key => key.startsWith('{urn:xpanel:dav}')) ? [[username, principal, name, collection.props, [...collection.items]]] : [])))),
    contacts: () => [...accounts.values()].flatMap(account => [...account].flatMap(([principal, collections]) => [...collections.values()].flatMap(collection => [...collection.items].flatMap(([href, item]) => {
      const card = parseDavContact(item.text)
      return card ? [{ ...card, id: href.replace(/\.vcf$/, ''), principal }] : []
    })))),
    seedContacts: (records, usernameOf) => {
      const shares = new Map<Collection, Record<string, unknown>>(), grantees = new Map<Collection, Set<string>>()
      for (const record of records) {
        // a record bound to no mailbox has no place in a store keyed by identity
        if (!record.ownerAuthority) continue
        const book = principalOf(usernameOf(record.ownerAuthority.accountId), record.ownerAuthority.serviceUserId).get('addressbook')!
        book.items.set(record.id + '.vcf', { text: record.vcard, etag: etagOf(record.vcard) })
        if (!record.shares?.length) continue
        shares.set(book, { ...shares.get(book), [record.id]: record.shares })
        const list = grantees.get(book) ?? new Set<string>()
        for (const share of record.shares) if (share.granteeAuthority) list.add(share.granteeAuthority.serviceUserId)
        grantees.set(book, list)
      }
      for (const [book, value] of shares) {
        book.props['{urn:xpanel:dav}contact-shares'] = JSON.stringify(value)
        book.props['{urn:xpanel:dav}grantees'] = [...grantees.get(book) ?? []].join(',')
      }
    },
    seedCalendars: (records, usernameOf) => {
      for (const record of records) {
        if (!record.ownerAuthority) continue
        const collections = principalOf(usernameOf(record.ownerAuthority.accountId), record.ownerAuthority.serviceUserId)
        collections.set(record.id, { props: { tag: 'VCALENDAR', 'C:supported-calendar-component-set': 'VEVENT', 'D:displayname': record.name, 'ICAL:calendar-color': record.color,
          '{urn:xpanel:dav}timezone': record.timezone, '{urn:xpanel:dav}created': record.createdAt, '{urn:xpanel:dav}shares': JSON.stringify(record.shares),
          '{urn:xpanel:dav}grantees': record.shares.flatMap(share => share.granteeAuthority ? [share.granteeAuthority.serviceUserId] : []).join(',') },
        items: new Map((record.events ?? []).map(event => { const text = renderDavEvent(event); return [event.id + '.ics', { text, etag: etagOf(text) }] })) })
      }
    },
    seedGroups: (username, principal, groups) => { principalOf(username, principal).get('addressbook')!.props['{urn:xpanel:dav}contact-groups'] = JSON.stringify(groups) },
    groups: (username, principal) => principalOf(username, principal).get('addressbook')!.props['{urn:xpanel:dav}contact-groups'] ?? null,
    omit: count => { omitted = count },
    pauseNextWrite: () => {
      let arrived!: () => void, release!: () => void
      const reached = new Promise<void>(resolve => { arrived = resolve }), gate = new Promise<void>(resolve => { release = resolve })
      pause = { arrived, gate }
      return { reached, release }
    },
  }
}
