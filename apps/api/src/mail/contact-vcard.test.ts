import { describe, expect, it } from 'vitest'
import { readContactVcards, rewriteContactVcard } from './contact-vcard.ts'
import { createWorkspaceContact, updateWorkspaceContact, updateWorkspaceContactGroups } from './contact-workspace.ts'
const fields = { fullName: 'Original', email: 'original@example.test', phone: '+123456', organization: 'Original team', title: 'Original title' }
const card = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:external-original-uid\r\nFN:Original\r\nEMAIL;TYPE=WORK:original@example.test\r\nTEL:+123456\r\nORG:Original team\r\nTITLE:Original title\r\nNOTE:Opaque note\r\n folded continuation\r\nX-CUSTOM:preserved\\, value\r\nEND:VCARD'
describe('single bounded contact vCard codec', () => {
  it('indexes imported fields and keeps exact UID, opaque properties and folding', () => {
    expect(readContactVcards(card)).toEqual([{ ...fields, groups: [], vcard: card }])
    expect(readContactVcards(card + '\r\n' + card)).toHaveLength(2)
  })
  it('changes only categories during group operations', () => {
    const original = { ...createWorkspaceContact('inbox@example.test', fields), vcard: card }
    const grouped = updateWorkspaceContactGroups(original, ['Friends, team'])
    expect(grouped.vcard.replace('CATEGORIES:Friends\\, team\r\n','')).toBe(card)
    expect(updateWorkspaceContactGroups(grouped, []).vcard).toBe(card)
    expect(readContactVcards(grouped.vcard)[0]!.groups).toEqual(['Friends, team'])
  })
  it('changes only edited supported properties and preserves field parameters', () => {
    const original = { ...createWorkspaceContact('inbox@example.test', fields), vcard: card }
    const updated = updateWorkspaceContact(original, { ...fields, email: 'changed@example.test', title: '' })
    expect(updated.vcard).toBe(card.replace('original@example.test','changed@example.test').replace('TITLE:Original title\r\n',''))
    expect(updated).not.toHaveProperty('expectedRevision')
  })
  it('refuses ambiguous edits instead of discarding additional values', () => {
    expect(() => rewriteContactVcard(card.replace('TEL:+123456','TEL:+123456\r\nTEL:+987654'), { TEL: 'changed' })).toThrow(/multiple vCard values/)
  })
  it.each(['BEGIN:VCARD\nFN:x', card + '\nforeign', card.replace('NOTE:', 'NOTE:\u0000'), card.repeat(5000)])('refuses incomplete, unsafe or over-budget source', source => {
    expect(() => readContactVcards(source)).toThrow()
  })
})
