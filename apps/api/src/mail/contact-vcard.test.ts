import { describe, expect, it } from 'vitest'
import { MAX_STORED_CARD_BYTES, readContactVcards, rewriteContactVcard } from './contact-vcard.ts'
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
  // Arabic "\u0646\u0648\u0631" in UTF-8 and "caf\u00e9" in Latin-1, as vCard 2.1 exports write them.
  const legacy = 'BEGIN:VCARD\r\nVERSION:2.1\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D9=86=D9=88=\r\n=D8=B1\r\nORG;ENCODING=QUOTED-PRINTABLE;CHARSET=ISO-8859-1:caf=E9\r\nTITLE;ENCODING=BASE64;CHARSET=UTF-8:Qm9zcw==\r\nTEL;QUOTED-PRINTABLE:=2B123\r\nPHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ\r\nEND:VCARD\r\n'
  it('reads quoted-printable and base64 fields in their character sets, soft line breaks included', () => {
    expect(readContactVcards(legacy)[0]).toMatchObject({ fullName: '\u0646\u0648\u0631', organization: 'caf\u00e9', title: 'Boss', phone: '+123', vcard: legacy })
  })
  it('writes a changed field as plain UTF-8, whole, and leaves the other encoded fields alone', () => {
    const changed = rewriteContactVcard(legacy, { FN: 'Noor' })
    expect(changed).toContain('\r\nFN:Noor\r\nORG;ENCODING=QUOTED-PRINTABLE;CHARSET=ISO-8859-1:caf=E9\r\n')
    expect(changed).not.toContain('=D8=B1')
    expect(rewriteContactVcard(legacy, { TEL: '+456' })).toContain('\r\nTEL:+456\r\nPHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ\r\n')
    expect(readContactVcards(changed)[0]).toMatchObject({ fullName: 'Noor', organization: 'caf\u00e9' })
  })
  it.each([
    'FN;ENCODING=X-CUSTOM:abc', 'FN;ENCODING=QUOTED-PRINTABLE:=ZZ', 'FN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:=FF', 'FN;ENCODING=QUOTED-PRINTABLE;CHARSET=X-MADE-UP:abc', 'FN;ENCODING=BASE64:***',
  ])('refuses a field it cannot decode: %s', property => {
    expect(() => readContactVcards('BEGIN:VCARD\r\n' + property + '\r\nEND:VCARD\r\n')).toThrow()
  })
  it('keeps the import bound, and reads a larger stored card with its embedded photo', () => {
    const photo = 'BEGIN:VCARD\r\nFN:Photo\r\nPHOTO;ENCODING=b;TYPE=JPEG:' + 'A'.repeat(300 * 1024) + '\r\nEND:VCARD\r\n'
    expect(() => readContactVcards(photo)).toThrow()
    expect(readContactVcards(photo, MAX_STORED_CARD_BYTES)[0]?.fullName).toBe('Photo')
  })
  it.each(['BEGIN:VCARD\nFN:x', card + '\nforeign', card.replace('NOTE:', 'NOTE:\u0000'), card.repeat(5000)])('refuses incomplete, unsafe or over-budget source', source => {
    expect(() => readContactVcards(source)).toThrow()
  })
})
