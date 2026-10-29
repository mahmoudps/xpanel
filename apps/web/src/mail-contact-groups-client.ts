/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import { contactBrowserBinding } from './mail-contacts-workspace-client.ts'
import type { MailContact } from './mail-contacts-workspace-client.ts'

type ContactRuntime = Pick<typeof import('./mail-contacts-workspace-client.ts'), 'contactObject' | 'contactStable' | 'contactReviewFlags' | 'contactWriteUncertain' | 'readMailContact' | 'readMailContacts'>
type ContactGroup = { name: string; contactIds: string[]; revision: string }
type GroupContact = Pick<MailContact, 'id' | 'owner' | 'fullName' | 'email' | 'groups' | 'revision'>
type ContactCapacity = { ownedContacts: number; maxContacts: number; groups: number; maxGroups: number; maxGroupsPerContact: number }
type GroupSnapshot = { groups: ContactGroup[]; revision: string; capacity: ContactCapacity; contacts: GroupContact[] }

/** Bound only to the sealed mailbox's real contact/group routes. */
function bindMailContactGroups(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined, runtime: ContactRuntime): void {
  const { contactObject, contactStable, contactReviewFlags, contactWriteUncertain, readMailContact } = runtime
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
  const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
  const groupName = (value: unknown): value is string => typeof value === 'string' && value === value.trim() && value === value.normalize('NFC') && value.isWellFormed() && Array.from(value).length >= 1 && Array.from(value).length <= 64 && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(value)
  const sorted = (values: readonly string[]): string[] => [...values].sort()
  const same = (left: readonly string[], right: readonly string[]): boolean => contactStable(sorted(left)) === contactStable(sorted(right))
  // Operational rendering bounds are separate from product capacity and never truncate data.
  const readBudget = { contacts: 20000, groups: 4096, memberships: 1000000 }
  const budgetError = (): { details: { reason: string; stateChanged: boolean } } => ({ details: { reason: 'contact_groups_read_budget', stateChanged: false } })
  const exceedsBudget = (error: unknown): boolean => contactObject(error) && contactObject(error.details) && error.details.reason === 'contact_groups_read_budget'
  const budgetMessage = (): string => t('This address book exceeds the group editor’s read budget. Your draft is kept; no data was truncated or changed. Existing contact editing and deletion remain available.')
  document.querySelectorAll<HTMLElement>('[data-mail-contact-groups]').forEach(root => {
    if (root.dataset.groupsBound === 'true') return
    root.dataset.groupsBound = 'true'
    const mailbox = root.dataset.groupsMailbox
    if (!mailbox) return
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.groupsManage === 'true' && !root.closest(denied)
    const control = <T extends HTMLElement>(key: string): T => root.querySelector<T>('[data-groups-' + key + ']')!
    const status = control<HTMLElement>('status'), picker = control<HTMLSelectElement>('select'), name = control<HTMLInputElement>('name')
    const members = control<HTMLSelectElement>('members'), contactPicker = control<HTMLSelectElement>('contact'), membership = control<HTMLSelectElement>('membership')
    if (!status || !picker || !name || !members || !contactPicker || !membership) return
    let snapshot: GroupSnapshot | null = null, selectedGroup = '', selectedContact = '', busy = false, confirming = false, review = false, externalPending = false
    const selectedValues = (input: HTMLSelectElement): string[] => [...input.selectedOptions].map(option => option.value)
    const ownContacts = (data = snapshot): GroupContact[] => data?.contacts ?? []
    const currentGroup = (): ContactGroup | null => snapshot?.groups.find(group => group.name === selectedGroup) ?? null
    const currentContact = (): GroupContact | null => ownContacts().find(contact => contact.id === selectedContact) ?? null
    const groupDirty = (): boolean => { const original = currentGroup(); return name.value !== (original?.name ?? '') || !same(selectedValues(members), original?.contactIds ?? []) }
    const membershipDirty = (): boolean => !!currentContact() && !same(selectedValues(membership), currentContact()!.groups)
    const dirty = (): boolean => groupDirty() || membershipDirty()
    const announce = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const lock = (): void => {
      const disabled = !admitted() || !snapshot || busy || confirming || review
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(input => { input.disabled = disabled })
      control<HTMLButtonElement>('reload').disabled = !admitted() || busy || confirming
      control<HTMLButtonElement>('new').disabled = disabled || snapshot!.capacity.groups >= snapshot!.capacity.maxGroups
      control<HTMLButtonElement>('save').disabled = disabled || !groupDirty() || !currentGroup() && snapshot!.capacity.groups >= snapshot!.capacity.maxGroups
      control<HTMLButtonElement>('delete').disabled = disabled || !currentGroup()
      control<HTMLButtonElement>('membership-save').disabled = disabled || !currentContact() || !membershipDirty()
      membership.disabled = disabled || !currentContact()
      root.setAttribute('aria-busy', String(busy || confirming))
    }
    const parseCapacity = (value: unknown): ContactCapacity => {
      if (!contactObject(value)) throw new Error('invalid_contact_capacity')
      for (const key of ['ownedContacts', 'maxContacts', 'groups', 'maxGroups', 'maxGroupsPerContact']) if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || (value[key] as number) < (key === 'ownedContacts' || key === 'groups' ? 0 : 1)) throw new Error('invalid_contact_capacity')
      return { ownedContacts: value.ownedContacts as number, maxContacts: value.maxContacts as number, groups: value.groups as number, maxGroups: value.maxGroups as number, maxGroupsPerContact: value.maxGroupsPerContact as number }
    }
    const parseGroup = (value: unknown): ContactGroup => {
      if (!contactObject(value) || !groupName(value.name) || !revision(value.revision) || !Array.isArray(value.contactIds) || !value.contactIds.every(id => typeof id === 'string' && uuid.test(id)) || new Set(value.contactIds).size !== value.contactIds.length) throw new Error('invalid_contact_group')
      return { name: value.name, contactIds: value.contactIds as string[], revision: value.revision }
    }
    const candidate = (value: unknown): GroupContact => {
      if (!contactObject(value) || typeof value.id !== 'string' || !uuid.test(value.id) || value.owner !== mailbox || !revision(value.revision) || !Array.isArray(value.groups) || !value.groups.every(groupName)) throw new Error('invalid_group_contact')
      for (const key of ['fullName', 'email'] as const) if (typeof value[key] !== 'string' || !(value[key] as string).isWellFormed() || !(value[key] as string).trim() || value[key] !== (value[key] as string).trim() || /[\r\n\u0000]/u.test(value[key] as string)) throw new Error('invalid_group_contact_text')
      if ((value.email as string).toLowerCase() !== value.email) throw new Error('invalid_group_contact_email')
      return { id: value.id, owner: mailbox, fullName: value.fullName as string, email: value.email as string, groups: [...value.groups] as string[], revision: value.revision }
    }
    const scoped = (value: unknown): value is Record<string, unknown> => contactObject(value) && contactObject(value.context) && value.context.mailbox === mailbox && !contactReviewFlags(value)
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!send || !admitted()) return Promise.reject({ details: { stateChanged: false } })
      return body === undefined ? send(method, path) : send(method, path, body)
    }
    const read = async (): Promise<GroupSnapshot> => {
      const raw = await request('GET', '/api/webmail/contact-groups')
      if (!scoped(raw) || !revision(raw.revision) || !Array.isArray(raw.groups) || !Array.isArray(raw.contacts)) throw new Error('invalid_contact_groups')
      if (raw.metadataReview !== undefined && (!contactObject(raw.metadataReview) || Object.keys(raw.metadataReview).length !== 2 || raw.metadataReview.status !== 'review_required' || raw.metadataReview.reason !== 'mailbox_metadata_binding_unverified')) throw new Error('invalid_metadata_review')
      if (raw.groups.length > readBudget.groups || raw.contacts.length > readBudget.contacts || raw.groups.reduce((count: number, group: unknown) => count + (contactObject(group) && Array.isArray(group.contactIds) ? group.contactIds.length : 0), 0) > readBudget.memberships) throw budgetError()
      const groups = raw.groups.map(parseGroup), contacts = raw.contacts.map(candidate), capacity = parseCapacity(raw.capacity)
      const people = new Map(contacts.map(contact => [contact.id, contact])), groupMembers = new Map(groups.map(group => [group.name, new Set(group.contactIds)]))
      const contactGroups = new Map(contacts.map(contact => [contact.id, new Set(contact.groups)]))
      if (people.size !== contacts.length || groupMembers.size !== groups.length || capacity.groups !== groups.length || capacity.ownedContacts !== contacts.length || groups.some(group => group.contactIds.some(id => !people.has(id) || !contactGroups.get(id)!.has(group.name)))) throw new Error('incoherent_contact_groups')
      for (const contact of contacts) if (contact.groups.some(name => !groupMembers.get(name)?.has(contact.id))) throw new Error('incoherent_contact_membership')
      return { groups, revision: raw.revision, capacity, contacts }
    }
    const option = (input: HTMLSelectElement, value: string, label: string, selected = false): void => { const entry = document.createElement('option'); entry.value = value; entry.textContent = label; entry.selected = selected; input.append(entry) }
    const capacity = (): void => {
      if (!snapshot) return
      for (const [key, value] of [['contact-capacity', snapshot.capacity.ownedContacts + ' / ' + snapshot.capacity.maxContacts], ['capacity', snapshot.capacity.groups + ' / ' + snapshot.capacity.maxGroups], ['membership-capacity', String(snapshot.capacity.maxGroupsPerContact)]] as const) {
        const target = control<HTMLElement>(key), isolated = document.createElement('bdi'); isolated.dir = 'ltr'; isolated.textContent = value; target.replaceChildren(isolated)
      }
      window.dispatchEvent(new CustomEvent('xpanel:contact-capacity', { detail: { mailbox, ...snapshot.capacity } }))
    }
    const install = (data: GroupSnapshot, group = selectedGroup, contact = selectedContact): void => {
      snapshot = data; review = false
      selectedGroup = data.groups.some(item => item.name === group) ? group : ''
      selectedContact = ownContacts().some(item => item.id === contact) ? contact : ''
      const chosenGroup = currentGroup(), chosenContact = currentContact()
      const selectedMembers = new Set(chosenGroup?.contactIds ?? []), assignedGroups = new Set(chosenContact?.groups ?? [])
      picker.textContent = ''; option(picker, '', t('New group'))
      for (const item of data.groups) option(picker, item.name, item.name, item.name === selectedGroup)
      picker.value = selectedGroup; name.value = chosenGroup?.name ?? ''
      members.textContent = ''; contactPicker.textContent = ''; option(contactPicker, '', t('Select an owned contact'))
      for (const item of ownContacts()) { const label = item.fullName + ' · ' + item.email; option(members, item.id, label, selectedMembers.has(item.id)); option(contactPicker, item.id, label, item.id === selectedContact) }
      contactPicker.value = selectedContact; membership.textContent = ''
      for (const item of data.groups) option(membership, item.name, item.name, assignedGroups.has(item.name))
      capacity(); lock()
    }
    const confirm = async (title: string, body: string, danger = false): Promise<boolean> => {
      if (!askDialog) { announce('failed', t('Confirmation is unavailable. Nothing was changed.')); return false }
      confirming = true; lock()
      try { return await askDialog({ title, body, danger, confirm: t('Confirm') }) === true }
      catch { return false }
      finally { confirming = false; lock() }
    }
    const discard = (): Promise<boolean> => !dirty() && !review ? Promise.resolve(true) : confirm(t('Discard group and membership drafts?'), t('Unsaved edits will be discarded and saved data will be read again. No previous mutation is retried.'), true)
    const externalRefresh = (): void => {
      if (busy || confirming) { externalPending = true; return }
      if (dirty() || review) { review = true; announce('stale', t('Contacts changed elsewhere. Your drafts are kept. Explicitly read and review saved groups before another change.')); lock(); return }
      void reload(false)
    }
    const reload = async (explicit = true, group = selectedGroup, contact = selectedContact): Promise<void> => {
      if (busy || confirming || !admitted()) return
      if (explicit && !await discard()) return
      if (busy || confirming || !admitted()) return
      busy = true; lock(); announce('reading', t('Reading saved groups, contacts and capacity…'))
      try { install(await read(), group, contact); announce('read', t('Saved groups and capacity read. Shared contacts remain read-only; synchronization is unverified.')) }
      catch (error) { if (exceedsBudget(error)) { review = true; announce('unavailable', budgetMessage()) } else announce('failed', t('Saved groups could not be read coherently. Drafts are preserved; nothing was changed.')) }
      finally { busy = false; lock(); if (externalPending) { externalPending = false; externalRefresh() } }
    }
    const mutate = async (kind: 'group' | 'delete' | 'membership'): Promise<void> => {
      if (busy || confirming || review || !snapshot || !admitted()) return
      const original = currentGroup(), contact = currentContact(), source = snapshot
      const proposedName = name.value.trim().normalize('NFC'), ids = selectedValues(members), groupNames = selectedValues(membership)
      let path: string, method: string, body: Record<string, unknown>
      try {
        if (kind === 'membership') {
          if (!contact || !membershipDirty() || groupNames.length > source.capacity.maxGroupsPerContact && groupNames.length > contact.groups.length || groupNames.some(name => !source.groups.some(group => group.name === name))) throw new Error('invalid_membership')
          path = '/api/webmail/contacts/' + encodeURIComponent(contact.id) + '/groups'; method = 'PUT'; body = { groups: groupNames, expectedRevision: contact.revision }
        } else if (kind === 'delete') {
          if (!original) return
          path = '/api/webmail/contact-groups/' + encodeURIComponent(original.name); method = 'DELETE'; body = { expectedRevision: original.revision }
        } else {
          if (!groupName(proposedName) || !groupDirty() || !original && source.capacity.groups >= source.capacity.maxGroups || source.groups.some(group => group.name === proposedName && group.name !== original?.name)) throw new Error('invalid_group')
          path = '/api/webmail/contact-groups' + (original ? '/' + encodeURIComponent(original.name) : ''); method = original ? 'PATCH' : 'POST'; body = { name: proposedName, contactIds: ids, expectedRevision: original?.revision ?? source.revision }
        }
      } catch { announce('failed', t('Check the group name, membership and server capacity limits. Nothing was sent.')); return }
      const label = kind === 'membership' ? contact!.fullName : kind === 'delete' ? original!.name : proposedName
      const losingDraft = kind === 'membership' ? groupDirty() : membershipDirty() || kind === 'delete' && groupDirty()
      const hint = (kind === 'delete' ? t('This removes the group from its contacts. The contacts are kept.') : t('The exact reviewed group membership will be saved. No mail is sent or synchronized.')) + (losingDraft ? '\n' + t('Other unsaved group or membership edits will be discarded.') : '')
      if (!await confirm(kind === 'delete' ? t('Delete contact group?') : t('Save contact groups?'), label + '\n' + hint, kind === 'delete')) return
      if (!admitted() || busy) return
      busy = true; lock(); let dispatched = false
      try {
        const before = await read()
        const beforePeople = new Map(before.contacts.map(contact => [contact.id, contact]))
        const current = original ? before.groups.find(group => group.name === original.name) : null
        const currentPerson = contact ? beforePeople.get(contact.id) : null
        const stale = kind === 'membership' ? !currentPerson || currentPerson.revision !== contact!.revision : original ? !current || current.revision !== original.revision : before.revision !== source.revision
        const validMembers = ids.every(id => beforePeople.has(id))
        if (stale || kind === 'group' && !validMembers || kind === 'membership' && groupNames.some(name => !before.groups.some(group => group.name === name))) { review = true; announce('stale', t('The saved target changed. Your drafts are preserved. Read and review saved groups before retrying.')); return }
        if (kind === 'group' && ids.some(id => { const previous = beforePeople.get(id)!.groups; const next = new Set(previous.filter(name => name !== original?.name && name !== proposedName)).size + 1; return next > before.capacity.maxGroupsPerContact && next > previous.length })) throw { details: { stateChanged: false } }
        dispatched = true
        const raw = await request(method, path, body)
        if (!scoped(raw) || raw.stateChanged !== true) throw new Error('invalid_group_acknowledgement')
        let accepted: ContactGroup | MailContact | null = null
        if (kind === 'membership') {
          const acceptedContact = readMailContact(raw.contact, mailbox)
          if (acceptedContact.owner !== mailbox || acceptedContact.id !== contact!.id || !same(acceptedContact.groups, groupNames) || (['fullName', 'email'] as const).some(key => acceptedContact[key] !== contact![key])) throw new Error('wrong_membership_acknowledgement')
          accepted = acceptedContact
        } else {
          if (!revision(raw.revision)) throw new Error('invalid_group_revision')
          parseCapacity(raw.capacity)
          if (kind === 'delete') { if (raw.deletedGroup !== original!.name) throw new Error('wrong_group_delete_acknowledgement') }
          else { accepted = parseGroup(raw.group); if (accepted.name !== proposedName || !same(accepted.contactIds, ids)) throw new Error('wrong_group_acknowledgement') }
        }
        const after = await read()
        if (kind === 'membership') {
          const observed = after.contacts.find(row => row.id === contact!.id && row.owner === mailbox)
          if (!observed || contactStable(observed) !== contactStable(candidate(accepted))) throw new Error('membership_readback_mismatch')
        } else {
          if (after.revision !== raw.revision) throw new Error('group_collection_readback_mismatch')
          if (kind === 'delete') { if (after.groups.some(group => group.name === original!.name) || ownContacts(after).some(row => row.groups.includes(original!.name))) throw new Error('group_delete_readback_mismatch') }
          else {
            const observed = after.groups.find(group => group.name === proposedName)
            if (!observed || contactStable(observed) !== contactStable(accepted) || original && original.name !== proposedName && after.groups.some(group => group.name === original.name)) throw new Error('group_readback_mismatch')
          }
        }
        install(after, kind === 'delete' ? '' : kind === 'group' ? proposedName : selectedGroup, kind === 'membership' ? contact!.id : selectedContact)
        announce('saved', t('The reviewed groups were stored and read back. Contacts are preserved; no mail was sent or synchronized.'))
        window.dispatchEvent(new CustomEvent('xpanel:contacts-changed', { detail: { source: 'contact-groups', mailbox } }))
      } catch (error) {
        if (exceedsBudget(error)) { review = true; announce('unavailable', budgetMessage()); return }
        review = dispatched && contactWriteUncertain(error)
        const conflict = contactObject(error) && error.status === 409
        review ||= conflict
        announce(review ? conflict ? 'stale' : 'uncertain' : 'failed', review ? t('The outcome requires review. Drafts are kept and no mutation was retried. Explicitly read saved groups before continuing.') : t('The request was refused or could not complete. Drafts are kept; nothing was retried.'))
      } finally { busy = false; lock(); if (externalPending) { externalPending = false; externalRefresh() } }
    }
    if (!send || !admitted()) { root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(input => { input.disabled = true }); announce('unavailable', t('Group management is unavailable here. Nothing was read or changed.')); return }
    for (const input of [name, members, membership]) input.addEventListener(input === name ? 'input' : 'change', lock)
    control<HTMLButtonElement>('reload').addEventListener('click', () => { void reload() })
    control<HTMLButtonElement>('new').addEventListener('click', () => { if (!control<HTMLButtonElement>('new').disabled) void reload(true, '', selectedContact) })
    picker.addEventListener('change', () => { const value = picker.value; picker.value = selectedGroup; void reload(true, value, selectedContact) })
    contactPicker.addEventListener('change', () => { const value = contactPicker.value; contactPicker.value = selectedContact; void reload(true, selectedGroup, value) })
    control<HTMLButtonElement>('save').addEventListener('click', () => { void mutate('group') })
    control<HTMLButtonElement>('delete').addEventListener('click', () => { void mutate('delete') })
    control<HTMLButtonElement>('membership-save').addEventListener('click', () => { void mutate('membership') })
    window.addEventListener('xpanel:contacts-changed', event => { const detail = (event as CustomEvent).detail; if (contactObject(detail) && detail.mailbox === mailbox && detail.source !== 'contact-groups') externalRefresh() })
    window.addEventListener('beforeunload', event => { if (dirty() || review) { event.preventDefault(); event.returnValue = '' } })
    void reload(false)
  })
}

export const MAIL_CONTACT_GROUPS_CLIENT_BINDING = contactBrowserBinding(bindMailContactGroups, true)
