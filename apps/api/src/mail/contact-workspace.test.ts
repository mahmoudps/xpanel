import { describe, expect, it } from 'vitest'
import {
  assertContactCapacity, CONTACTS_PER_MAILBOX_MAX, contactWorkspaceRevision, createWorkspaceContact,
  normalizeContactGroupName, normalizeContactGroups, parseContactVcardGroups, projectContactWorkspace, updateWorkspaceContact, updateWorkspaceContactGroups,
} from './contact-workspace.ts'

const owner = 'inbox@example.test'
const fields = { fullName: 'Contact', email: 'contact@example.test', phone: '', organization: '', title: '' }

describe('mailbox contact group and capacity contracts', () => {
  it('normalizes safe Unicode labels without changing case or natural identity', () => {
    expect(normalizeContactGroupName('  Friends  ')).toBe('Friends')
    expect(normalizeContactGroupName('Cafe\u0301')).toBe('Café')
    expect(normalizeContactGroupName('العائلة')).toBe('العائلة')
    expect(normalizeContactGroupName('😀'.repeat(64))).toHaveLength(128)
  })
  it.each([null, 1, '', '   ', 'a'.repeat(65), 'a\nb', 'a\u0000b', 'a\u061cb', 'a\u200eb', 'a\u200fb', 'a\u202eb', 'a\u2066b', '\ud800'])('refuses unsafe or oversized group name %s', value => {
    expect(() => normalizeContactGroupName(value)).toThrow()
  })
  it('bounds unique contact group arrays', () => {
    expect(normalizeContactGroups(['Friends', 'العائلة'])).toEqual(['Friends', 'العائلة'])
    for (const value of ['Friends', ['Friends', ' Friends '], Array.from({ length: 33 }, (_, index) => String(index)), ['x\ry']]) {
      expect(() => normalizeContactGroups(value)).toThrow()
    }
    const legacy = Array.from({ length: 34 }, (_, index) => 'Legacy ' + index)
    expect(normalizeContactGroups(legacy.slice(0, 33), legacy)).toHaveLength(33)
    expect(() => normalizeContactGroups([...legacy, 'Growth'], legacy)).toThrow()
  })
  it('retains existing data above a cap while refusing any further growth for that mailbox', () => {
    const contact = createWorkspaceContact(owner, fields)
    const contacts = Array.from({ length: CONTACTS_PER_MAILBOX_MAX }, () => contact)
    expect(() => assertContactCapacity(contacts, owner, 0)).not.toThrow()
    expect(() => assertContactCapacity(contacts, owner, 1)).toThrow()
    expect(() => assertContactCapacity(contacts, 'other@example.test', 1)).not.toThrow()
    expect(() => assertContactCapacity(contacts, owner, -1)).toThrow()
  })
  it('updates group membership and exported vCard categories from the same saved data', () => {
    const original = createWorkspaceContact(owner, fields)
    const grouped = updateWorkspaceContactGroups(original, ['Friends, team', 'Semi;colon', 'Back\\slash'])
    expect(grouped.groups).toEqual(['Friends, team', 'Semi;colon', 'Back\\slash'])
    expect(grouped.vcard).toContain('CATEGORIES:Friends\\, team,Semi\\;colon,Back\\\\slash')
    expect(parseContactVcardGroups('Friends\\, team,Semi\\;colon,Back\\\\slash')).toEqual(grouped.groups)
    expect(contactWorkspaceRevision(grouped)).not.toBe(contactWorkspaceRevision(original))
    expect(updateWorkspaceContact(grouped, { ...fields, fullName: 'Edited' }).vcard).toContain('CATEGORIES:Friends\\, team,Semi\\;colon,Back\\\\slash')
    expect(updateWorkspaceContactGroups(grouped, []).vcard).not.toContain('CATEGORIES:')
    expect(original.groups).toEqual([])
  })
  it('keeps authority pins private while binding public revisions to them', () => {
    const original = createWorkspaceContact(owner, fields)
    const authority = { accountId: original.id, serviceUserId: original.id, mailbox: owner }
    const bound = { ...original, ownerAuthority: authority, shares: [{ principal: owner, permission: 'read' as const, sharedAt: original.createdAt, granteeAuthority: authority }] }
    const projection = projectContactWorkspace(bound)
    expect(projection).not.toHaveProperty('ownerAuthority')
    expect(projection.shares).toEqual([{ principal: owner, permission: 'read', sharedAt: original.createdAt }])
    expect(projection.revision).not.toBe(contactWorkspaceRevision(original))
  })

})
