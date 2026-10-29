import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assessMailboxMetadataAuthority, fail, isXpanelError } from '@xpanel/core'
import type { MailboxMetadataAuthority } from '@xpanel/core'
import { assertMailboxMetadataAuthority, captureMailboxMetadataAuthority, resolveMailboxMetadataAuthority, MAILBOX_METADATA_REVIEW_REQUIRED } from './metadata-authority.ts'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { ExtendedRouteHelpers, WebmailContact } from '../extended-routes.ts'
import type { AuthenticatedCaller } from '../auth.ts'
import { isMailboxPrincipal, requireMailboxPrincipalAccess } from '../authorization.ts'
import {
  CONTACTS_PER_MAILBOX_MAX, CONTACT_GROUPS_PER_MAILBOX_MAX, CONTACT_GROUPS_PER_CONTACT_MAX, assertContactCapacity,
  contactWorkspaceRevision, normalizeContactGroupName, normalizeContactGroups,
  projectContactWorkspace, updateWorkspaceContactGroups,
} from './contact-workspace.ts'

interface ContactGroupDefinition { owner: string; ownerAuthority?: MailboxMetadataAuthority; name: string; createdAt: string | null }
export interface ContactToolsRoutePorts extends Pick<ExtendedRouteHelpers, 'store' | 'requireCaller' | 'emitAudit'> {
  /** Trusted storage dependency; the default uses the same canonical files as legacy contacts. */
  writeJson?: typeof atomicWriteJson
}
const CONTACTS = 'extended/webmail/contacts.json'
const GROUPS = 'extended/webmail/contact-groups.json'
export const CONTACT_GROUPS_READ_BUDGET = { maxContacts: 20000, maxGroups: 4096, maxMemberships: 1000000, maxResponseBytes: 16 * 1024 * 1024 } as const
const REVISION = /^[0-9a-f]{64}$/
const CONTACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const sameCaller = (before: AuthenticatedCaller, after: AuthenticatedCaller): boolean => before.principal.id === after.principal.id && before.principal.kind === after.principal.kind
  && before.sessionId === after.sessionId && before.apiTokenId === after.apiTokenId

const parseRequest = async (req: Request, allowed: readonly string[]): Promise<Record<string, unknown>> => {
  let body: unknown
  try { body = await req.json() } catch { return fail('VALIDATION', 'contact tools require a JSON object', { stateChanged: false }) }
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) return fail('VALIDATION', 'unsupported contact tools field', { stateChanged: false })
  if (typeof body.expectedRevision !== 'string' || !REVISION.test(body.expectedRevision)) return fail('VALIDATION', 'expectedRevision is required', { stateChanged: false })
  return body
}

/** Current owner and grantee lifetime proof is required before any contact content is visible. */
export const createContactMetadataAccess = (store: ContactToolsRoutePorts['store'], current: MailboxMetadataAuthority) => {
  const authorities = new Map<string, Promise<MailboxMetadataAuthority | null>>()
  return async (contact: WebmailContact): Promise<{ owner: boolean; permission: 'read' | 'read-write' } | null> => {
    if (!contact || typeof contact.owner !== 'string') return null
    if (contact.owner.toLowerCase() === current.mailbox) return assessMailboxMetadataAuthority(contact.owner, contact.ownerAuthority, current) === 'match' ? { owner: true, permission: 'read-write' } : null
    const address = contact.owner.toLowerCase()
    let pending = authorities.get(address)
    if (!pending) { pending = resolveMailboxMetadataAuthority(store, address); authorities.set(address, pending) }
    const owner = await pending
    if (!owner || owner.accountId !== current.accountId || assessMailboxMetadataAuthority(contact.owner, contact.ownerAuthority, owner) !== 'match') return null
    const share = (Array.isArray(contact.shares) ? contact.shares : []).find(share => share && typeof share.principal === 'string' && (share.permission === 'read' || share.permission === 'read-write') && share.principal.toLowerCase() === current.mailbox && assessMailboxMetadataAuthority(share.principal, share.granteeAuthority, current) === 'match')
    return share ? { owner: false, permission: share.permission } : null
  }
}

const owned = (contacts: readonly WebmailContact[], mailbox: string): WebmailContact[] => contacts.filter(contact => contact.owner.toLowerCase() === mailbox)
const definitionsFor = (definitions: readonly ContactGroupDefinition[], contacts: readonly WebmailContact[], mailbox: string): ContactGroupDefinition[] => {
  const entries = new Map(definitions.filter(group => group.owner === mailbox).map(group => [group.name, group]))
  for (const contact of owned(contacts, mailbox)) for (const name of contact.groups) {
    if (normalizeContactGroupName(name) !== name) return fail('PRECONDITION_FAILED', 'stored contact groups require review', { stateChanged: false })
    if (!entries.has(name)) entries.set(name, { owner: mailbox, ...(contact.ownerAuthority ? { ownerAuthority: contact.ownerAuthority } : {}), name, createdAt: null })
  }
  return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name))
}
const projectGroups = (definitions: readonly ContactGroupDefinition[], contacts: readonly WebmailContact[], mailbox: string) => {
  const scoped = owned(contacts, mailbox), members = new Map<string, WebmailContact[]>()
  const catalog = definitionsFor(definitions, contacts, mailbox)
  for (const group of catalog) members.set(group.name, [])
  for (const contact of scoped) for (const name of contact.groups) members.get(name)?.push(contact)
  const revisions = new Map(scoped.map(contact => [contact.id, contactWorkspaceRevision(contact)]))
  return catalog.map(group => {
    const selected = members.get(group.name)!.sort((left, right) => left.id.localeCompare(right.id))
    return { name: group.name, contactIds: selected.map(contact => contact.id), revision: digest([group, selected.map(contact => [contact.id, revisions.get(contact.id)!])]) }
  })
}
const collectionRevision = (definitions: readonly ContactGroupDefinition[], contacts: readonly WebmailContact[], mailbox: string): string => digest([
  definitionsFor(definitions, contacts, mailbox), owned(contacts, mailbox).map(contact => [contact.id, contactWorkspaceRevision(contact)]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
])
const capacity = (definitions: readonly ContactGroupDefinition[], contacts: readonly WebmailContact[], mailbox: string) => ({
  ownedContacts: owned(contacts, mailbox).length, maxContacts: CONTACTS_PER_MAILBOX_MAX,
  groups: definitionsFor(definitions, contacts, mailbox).length, maxGroups: CONTACT_GROUPS_PER_MAILBOX_MAX, maxGroupsPerContact: CONTACT_GROUPS_PER_CONTACT_MAX,
})
const assertExpected = (expected: unknown, actual: string): void => {
  if (expected !== actual) fail('CONFLICT', 'contacts or group changed; reload before saving', { stateChanged: false })
}
const parseContactIds = (value: unknown, ownedCount: number): string[] => {
  if (!Array.isArray(value) || value.length > Math.max(CONTACTS_PER_MAILBOX_MAX, ownedCount) || value.some(id => typeof id !== 'string' || !CONTACT_ID.test(id))) return fail('VALIDATION', 'contactIds must be a bounded array of contact IDs', { stateChanged: false })
  const ids = value.map(id => String(id).toLowerCase())
  if (new Set(ids).size !== ids.length) return fail('VALIDATION', 'contactIds must be unique', { stateChanged: false })
  return ids
}

const storedDefinitions = (value: unknown): ContactGroupDefinition[] => {
  if (!Array.isArray(value)) return fail('PRECONDITION_FAILED', 'stored contact groups require review', { stateChanged: false })
  const seen = new Set<string>()
  for (const group of value) {
    let valid = object(group) && typeof group.owner === 'string' && /^[^\s@/\\]+@[^\s@/\\]+$/.test(group.owner) && group.owner === group.owner.toLowerCase()
      && typeof group.name === 'string' && (group.createdAt === null || typeof group.createdAt === 'string' && Number.isFinite(Date.parse(group.createdAt)))
    try { valid = valid && normalizeContactGroupName(group.name) === group.name } catch { valid = false }
    const key = object(group) ? JSON.stringify([group.owner, group.name]) : ''
    if (!valid || seen.has(key)) return fail('PRECONDITION_FAILED', 'stored contact groups require review', { stateChanged: false })
    seen.add(key)
  }
  return value as ContactGroupDefinition[]
}
const storedContacts = (value: unknown): WebmailContact[] => {
  if (!Array.isArray(value)) return fail('PRECONDITION_FAILED', 'stored contacts require review', { stateChanged: false })
  const seen = new Set<string>()
  for (const contact of value) {
    let valid = object(contact) && typeof contact.id === 'string' && CONTACT_ID.test(contact.id) && typeof contact.owner === 'string'
      && ['fullName', 'email', 'phone', 'organization', 'title', 'vcard', 'createdAt'].every(key => typeof contact[key] === 'string') && Array.isArray(contact.groups)
    if (valid) try { valid = contact.groups.every((name: unknown) => typeof name === 'string' && normalizeContactGroupName(name) === name) } catch { valid = false }
    if (!valid || seen.has(contact.id)) return fail('PRECONDITION_FAILED', 'stored contacts require review', { stateChanged: false })
    seen.add(contact.id)
  }
  return value as WebmailContact[]
}

/** Called while the legacy Contacts handler already holds the shared writer lease. */
export const assertContactMutationCapacity = async (store: ContactToolsRoutePorts['store'], current: readonly WebmailContact[], next: readonly WebmailContact[], mailbox: string): Promise<void> => {
  const previousById = new Map(current.map(contact => [contact.id, contact]))
  const owners = new Set([mailbox])
  for (const contact of next) {
    const previous = previousById.get(contact.id)
    if (!previous || JSON.stringify(previous.groups) !== JSON.stringify(contact.groups)) owners.add(contact.owner.toLowerCase())
  }
  for (const ownerMailbox of owners) {
    const authority = await captureMailboxMetadataAuthority(store, ownerMailbox)
    const matches = (contact: WebmailContact) => assessMailboxMetadataAuthority(contact.owner, contact.ownerAuthority, authority) === 'match'
    const before = owned(current.filter(matches), ownerMailbox), after = owned(next.filter(matches), ownerMailbox)
    assertContactCapacity(before, ownerMailbox, Math.max(0, after.length - before.length))
    const previousById = new Map(before.map(contact => [contact.id, contact]))
    const changes = after.filter(contact => { const previous = previousById.get(contact.id); return !previous || JSON.stringify(previous.groups) !== JSON.stringify(contact.groups) })
    if (!changes.length) continue
    for (const contact of changes) normalizeContactGroups(contact.groups, previousById.get(contact.id)?.groups)
    const raw = await readJsonIfExists(join(store.rootDir, GROUPS)) ?? []
    if (!Array.isArray(raw)) return fail('PRECONDITION_FAILED', 'stored contact groups require review', { stateChanged: false })
    const definitions = storedDefinitions(raw.filter(group => assessMailboxMetadataAuthority(group?.owner, group?.ownerAuthority, authority) === 'match'))
    const previousGroups = definitionsFor(definitions, before, ownerMailbox).length, nextGroups = definitionsFor(definitions, after, ownerMailbox).length
    if (nextGroups > CONTACT_GROUPS_PER_MAILBOX_MAX && nextGroups > previousGroups) return fail('LIMIT_EXCEEDED', 'mailbox contact group capacity reached', { stateChanged: false })
  }
}

/** Sealed-mailbox group/membership/deletion routes; legacy administrative contacts stay in their existing handler. */
export const createContactToolsRoutes = (ports: ContactToolsRoutePorts) => async (req: Request, url: URL, method = req.method.toUpperCase()): Promise<Response | null> => {
  const groupRoot = url.pathname === '/api/webmail/contact-groups'
  const groupMatch = /^\/api\/webmail\/contact-groups\/([^/]+)$/.exec(url.pathname)
  const membership = /^\/api\/webmail\/contacts\/([^/]+)\/groups$/.exec(url.pathname)
  const deletingCollection = method === 'DELETE' && url.pathname === '/api/webmail/contacts'
  const deleting = method === 'DELETE' ? /^\/api\/webmail\/contacts\/([^/]+)$/.exec(url.pathname) : null
  if (!groupRoot && !groupMatch && !membership && !deleting && !deletingCollection) return null
  const caller = await ports.requireCaller(req)
  if (!isMailboxPrincipal(caller)) {
    if (deleting || deletingCollection) return null
    return fail('FORBIDDEN', 'contact groups require a mailbox session', { stateChanged: false })
  }
  if (deletingCollection) return fail('VALIDATION', 'contact deletion requires an item path and its current expectedRevision; collection selectors are not supported', { stateChanged: false })
  if (url.searchParams.size) return fail('VALIDATION', deleting ? 'contact deletion requires its current expectedRevision and does not accept selectors' : 'contact tools do not accept selectors', { stateChanged: false })
  if (deleting && !CONTACT_ID.test(deleting[1]!)) return fail('VALIDATION', 'a valid contact ID is required', { stateChanged: false })
  const read = method === 'GET' && groupRoot
  const create = method === 'POST' && groupRoot
  const edit = method === 'PATCH' && Boolean(groupMatch)
  const remove = method === 'DELETE' && Boolean(groupMatch)
  const assign = method === 'PUT' && Boolean(membership)
  if (!read && !create && !edit && !remove && !assign && !deleting) return response({ code: 'METHOD_NOT_ALLOWED', stateChanged: false }, 405)
  const body = read ? null : await parseRequest(req, create || edit ? ['name', 'contactIds', 'expectedRevision'] : assign ? ['groups', 'expectedRevision'] : ['expectedRevision'])
  let groupName: string | null = null
  if (groupMatch) {
    try { groupName = decodeURIComponent(groupMatch[1]!) } catch { return fail('VALIDATION', 'invalid group name', { stateChanged: false }) }
    if (normalizeContactGroupName(groupName) !== groupName) return fail('VALIDATION', 'group path must contain its canonical name', { stateChanged: false })
  }
  const binding = await requireMailboxPrincipalAccess(ports.store, caller)
  const mailbox = binding.mailbox
  const lease = await ports.store.getWriterLock().acquire()
  const file = (path: string): string => join(ports.store.rootDir, path)
  let intentAttempted = false, journal = false, committed = false, saved: Record<string, unknown> | null = null
  let audit: { action: string; target: string } | null = null
  let fresh = caller, scopeAccount = binding.account
  try {
    fresh = await ports.requireCaller(req)
    if (!sameCaller(caller, fresh)) return fail('FORBIDDEN', 'contact authorization changed', { stateChanged: false })
    const currentBinding = await requireMailboxPrincipalAccess(ports.store, fresh)
    scopeAccount = currentBinding.account
    if (currentBinding.mailbox !== mailbox || currentBinding.serviceUserId !== binding.serviceUserId || currentBinding.account.id !== binding.account.id) return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
    const authority = await captureMailboxMetadataAuthority(ports.store, mailbox)
    const rawContacts = await readJsonIfExists(file(CONTACTS)) ?? [], rawDefinitions = await readJsonIfExists(file(GROUPS)) ?? []
    if (!Array.isArray(rawContacts) || !Array.isArray(rawDefinitions)) return fail('PRECONDITION_FAILED', 'stored contact collection requires review', { stateChanged: false })
    const matches = (record: { owner?: unknown; ownerAuthority?: unknown }) => assessMailboxMetadataAuthority(record?.owner, record?.ownerAuthority, authority) === 'match'
    const contacts = storedContacts(rawContacts.filter(matches))
    const definitions = storedDefinitions(rawDefinitions.filter(matches))
    const preserveContacts = (next: WebmailContact[]) => { const byId = new Map(next.map(contact => [contact.id, contact])); return rawContacts.flatMap(contact => matches(contact) ? byId.has(contact.id) ? [byId.get(contact.id)!] : [] : [contact]) }
    const preserveDefinitions = (next: ContactGroupDefinition[]) => [...rawDefinitions.filter(group => !matches(group)), ...next.map(group => ({ ...group, ownerAuthority: authority }))]
    if (read) {
      const scoped = owned(contacts, mailbox)
      const counts = { ownedContacts: scoped.length, groups: definitionsFor(definitions, contacts, mailbox).length, memberships: scoped.reduce((count, contact) => count + contact.groups.length, 0) }
      const refuse = (responseBytes?: number): never => fail('PRECONDITION_FAILED', 'contact groups exceed the operational read budget; no records were truncated or changed', {
        stateChanged: false, reason: 'contact_groups_read_budget', counts: { ...counts, ...(responseBytes === undefined ? {} : { responseBytes }) }, budget: CONTACT_GROUPS_READ_BUDGET,
      })
      if (counts.ownedContacts > CONTACT_GROUPS_READ_BUDGET.maxContacts || counts.groups > CONTACT_GROUPS_READ_BUDGET.maxGroups || counts.memberships > CONTACT_GROUPS_READ_BUDGET.maxMemberships) return refuse()
      const projected = scoped.map(contact => { const full = projectContactWorkspace(contact); return { id: full.id, owner: full.owner, fullName: full.fullName, email: full.email, groups: full.groups, revision: full.revision } })
      const document = { context: { mailbox }, metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED, contacts: projected, groups: projectGroups(definitions, contacts, mailbox), revision: collectionRevision(definitions, contacts, mailbox), capacity: capacity(definitions, contacts, mailbox) }
      const serialized = JSON.stringify(document), responseBytes = Buffer.byteLength(serialized, 'utf8')
      if (responseBytes > CONTACT_GROUPS_READ_BUDGET.maxResponseBytes) return refuse(responseBytes)
      return new Response(serialized, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
    }
    const inventory = projectGroups(definitions, contacts, mailbox)
    const revision = collectionRevision(definitions, contacts, mailbox)
    let nextContacts = contacts
    let nextDefinitions = [...definitions.filter(group => group.owner !== mailbox), ...definitionsFor(definitions, contacts, mailbox)]
    if (create || edit || remove) {
      const currentGroup = inventory.find(group => group.name === groupName)
      if (create) assertExpected(body!.expectedRevision, revision)
      else {
        if (!currentGroup) return fail('NOT_FOUND', 'contact group not found', { stateChanged: false })
        assertExpected(body!.expectedRevision, currentGroup.revision)
      }
      if (remove) {
        nextDefinitions = nextDefinitions.filter(group => group.owner !== mailbox || group.name !== groupName)
        nextContacts = contacts.map(contact => contact.owner.toLowerCase() === mailbox && contact.groups.includes(groupName!) ? updateWorkspaceContactGroups(contact, contact.groups.filter(name => name !== groupName)) : contact)
        saved = { deletedGroup: groupName }; audit = { action: 'webmail.contact_group.deleted', target: 'contact-group:' + groupName }
      } else {
        const name = normalizeContactGroupName(body!.name), ids = parseContactIds(body!.contactIds, owned(contacts, mailbox).length)
        if (inventory.some(group => group.name === name && (create || name !== groupName))) return fail('CONFLICT', 'contact group name already exists', { stateChanged: false })
        if (create && inventory.length >= CONTACT_GROUPS_PER_MAILBOX_MAX) return fail('LIMIT_EXCEEDED', 'mailbox contact group capacity reached', { stateChanged: false })
        const selected = new Set(ids)
        if (ids.some(id => !owned(contacts, mailbox).some(contact => contact.id === id))) return fail('NOT_FOUND', 'contact not found', { stateChanged: false })
        nextContacts = contacts.map(contact => {
          if (contact.owner.toLowerCase() !== mailbox) return contact
          const groups = contact.groups.filter(value => value !== groupName && value !== name)
          if (selected.has(contact.id)) groups.push(name)
          if (groups.length > Math.max(CONTACT_GROUPS_PER_CONTACT_MAX, contact.groups.length)) return fail('LIMIT_EXCEEDED', 'contact group capacity reached', { stateChanged: false })
          return JSON.stringify(groups) === JSON.stringify(contact.groups) ? contact : updateWorkspaceContactGroups(contact, groups)
        })
        const previous = nextDefinitions.find(group => group.owner === mailbox && group.name === groupName)
        nextDefinitions = nextDefinitions.filter(group => group.owner !== mailbox || group.name !== groupName)
        nextDefinitions.push({ owner: mailbox, ownerAuthority: authority, name, createdAt: previous ? previous.createdAt : new Date().toISOString() })
        saved = { groupName: name }; audit = { action: create ? 'webmail.contact_group.created' : 'webmail.contact_group.updated', target: 'contact-group:' + name }
      }
    } else {
      const id = (membership ?? deleting)![1]!.toLowerCase()
      const target = rawContacts.find(contact => contact?.id === id) as WebmailContact | undefined
      if (!target) return fail('NOT_FOUND', 'contact not found', { stateChanged: false })
      if (target.owner.toLowerCase() !== mailbox) {
        if (!await createContactMetadataAccess(ports.store, authority)(target)) return fail('NOT_FOUND', 'contact not found', { stateChanged: false })
        return fail('FORBIDDEN', 'only the contact owner may change groups or delete the contact', { stateChanged: false })
      }
      assertMailboxMetadataAuthority(target.owner, target.ownerAuthority, authority)
      assertExpected(body!.expectedRevision, contactWorkspaceRevision(target))
      if (assign) {
        const groups = normalizeContactGroups(body!.groups, target.groups)
        if (groups.some(name => !inventory.some(group => group.name === name))) return fail('NOT_FOUND', 'contact group not found', { stateChanged: false })
        const updated = updateWorkspaceContactGroups(target, groups)
        nextContacts = contacts.map(contact => contact === target ? updated : contact)
        saved = { contact: projectContactWorkspace(updated) }; audit = { action: 'webmail.contact.groups_updated', target: 'contact:' + id }
      } else {
        nextContacts = contacts.filter(contact => contact !== target)
        saved = { deletedContactId: id }; audit = { action: 'webmail.contact.deleted', target: 'contact:' + id }
      }
    }
    const backups = await Promise.all([CONTACTS, GROUPS].map(async relPath => {
      const content = await readFile(file(relPath)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      return { relPath, existed: content !== null, ...(content === null ? {} : { contentBase64: content.toString('base64') }) }
    }))
    intentAttempted = true
    await lease.recordIntent({ op: 'webmailContactTools', backups, createdRelPaths: [] })
    journal = true
    const write = ports.writeJson ?? atomicWriteJson
    const publishedContacts = preserveContacts(nextContacts), publishedDefinitions = preserveDefinitions(nextDefinitions)
    await write(file(CONTACTS), publishedContacts, 0o640, () => lease.assertFencingToken())
    await write(file(GROUPS), publishedDefinitions, 0o640, () => lease.assertFencingToken())
    if (digest(await readJsonIfExists(file(CONTACTS))) !== digest(publishedContacts) || digest(await readJsonIfExists(file(GROUPS))) !== digest(publishedDefinitions)) throw new Error('contact tools readback mismatch')
    await lease.commitAuthority({ incrementRevision: false }); committed = true
    await lease.clearIntent()
    const resultGroups = projectGroups(nextDefinitions, nextContacts, mailbox)
    if (saved?.groupName) saved = { group: resultGroups.find(group => group.name === saved!.groupName), revision: collectionRevision(nextDefinitions, nextContacts, mailbox), capacity: capacity(nextDefinitions, nextContacts, mailbox) }
    else if (remove) saved = { ...saved, revision: collectionRevision(nextDefinitions, nextContacts, mailbox), capacity: capacity(nextDefinitions, nextContacts, mailbox) }
  } catch (error) {
    if (intentAttempted && !journal) return fail('SERVICE_UNAVAILABLE', 'contact tools journal requires verification', { stateChanged: false, verificationRequired: true, unknownOutcome: true })
    if (journal && !committed) {
      try { await lease.rollbackIntent(); await lease.restorePreAcquireAuthorityIfUncommitted() }
      catch { return fail('SERVICE_UNAVAILABLE', 'contact tools recovery requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
    }
    if (committed) return fail('SERVICE_UNAVAILABLE', 'contact tools outcome requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false })
    return fail('SERVICE_UNAVAILABLE', journal ? 'contact tools write was refused and restored from recorded preimages' : 'contact tools could not be read or validated', { stateChanged: false })
  } finally { await lease.release() }
  try {
    await ports.emitAudit({ actor: fresh.principal.username, action: audit!.action, target: audit!.target, outcome: 'ok', principalId: fresh.principal.id }, { accountId: scopeAccount.id, resellerId: scopeAccount.ownerId })
  } catch { return fail('SERVICE_UNAVAILABLE', 'contact tools audit requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
  return response({ context: { mailbox }, ...saved, stateChanged: true }, create ? 201 : 200)
}
