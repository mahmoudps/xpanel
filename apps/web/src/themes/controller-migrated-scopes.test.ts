import { describe, expect, it } from 'vitest'
import { AUTHORITATIVE_CONTROLLER_DECLARATIONS } from './controller-hooks.ts'
import { checkControllerDeclarations } from './controller-conformance.ts'
import { parseMarkup } from './markup.ts'

const rule = (id: string) => {
  const found = AUTHORITATIVE_CONTROLLER_DECLARATIONS.find(item => item.id === id)
  if (!found) throw new Error('Missing reviewed controller ' + id)
  return found
}
const check = (id: string, html: string, route: string, surface: 'xpanel' | 'xwhm' | 'xmail' = 'xpanel') =>
  checkControllerDeclarations(parseMarkup(html), [rule(id)], { route, surface, qualified: true })

describe('reviewed migrated controller scopes', () => {
  const chooser = '<section data-ui-theme-preferences><form data-ui-theme-form><select data-ui-theme-choice></select><button data-ui-theme-save type="submit"></button></form><p data-ui-theme-status></p><button data-ui-theme-reload type="button"></button></section>'
  it('accepts the actual chooser form and rejects a save control with the wrong semantic type', () => {
    expect(check('ui-theme-preferences', chooser, '/home')).toEqual([])
    expect(check('ui-theme-preferences', chooser.replace('type="submit"', 'type="button"'), '/home')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'element', name: '[data-ui-theme-save]' })]))
  })
  it('requires chooser controls inside the owning form', () => {
    const displaced = chooser.replace('<select data-ui-theme-choice></select>', '').replace('</form>', '</form><select data-ui-theme-choice></select>')
    expect(check('ui-theme-preferences', displaced, '/home')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'relation', name: '[data-ui-theme-choice]' })]))
  })
  it('does not borrow a filter from a nested independently owned home root', () => {
    const html = '<html data-ui-theme="v2"><body><main data-panel-home><span id="tool-filter-count"></span><section data-tool-section></section><div data-tool-empty></div><section data-panel-home><input data-home-filter></section></main></body></html>'
    expect(check('panel-home-tools', html, '/home')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'hook', name: 'input[data-home-filter]' })]))
  })
  const ownedRows = '<tbody data-transfer-inventory-rows></tbody><tbody data-transfer-progress-rows></tbody><tbody data-transfer-plan-rows></tbody>'
  it('requires transfer observation rows inside the workspace owning detail route', () => {
    const valid = '<main data-whm-detail-route><section data-transfer-workspace></section><table>' + ownedRows + '</table></main>'
    expect(check('whm-transfer-dynamic-213', valid, '/whm/transfers', 'xwhm')).toEqual([])
    const foreign = '<main data-whm-detail-route><section data-transfer-workspace></section></main><main data-whm-detail-route><table>' + ownedRows + '</table></main>'
    expect(check('whm-transfer-dynamic-213', foreign, '/whm/transfers', 'xwhm')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'hook', name: 'tbody[data-transfer-inventory-rows]' })]))
  })
  it.each([
    ['account-mailing-lists', '/email/mailing-lists'],
    ['account-sessions', '/security/account'],
    ['directory-privacy', '/files/directory-privacy'],
    ['file-workspace-browse', '/files/manager'],
    ['file-workspace-trash', '/files/trash'],
  ])('requires the actual %s root on its admitted route', (id, route) => {
    expect(check(id, '<main></main>', route)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'controller', name: rule(id).rootSelector })]))
  })
  it('rejects a duplicate chooser control instead of accepting a plausible first match', () => {
    const duplicate = chooser.replace('</form>', '<select data-ui-theme-choice></select></form>')
    expect(check('ui-theme-preferences', duplicate, '/home')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'controller', name: 'select[data-ui-theme-choice]' })]))
  })
  it('requires the unified home root in a V2 document even when no root was rendered', () => {
    expect(check('panel-home-tools', '<html data-ui-theme="v2"><body><main></main></body></html>', '/home')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'controller', name: '[data-panel-home]' })]))
  })
  it('retains classic desktop filter authority without requiring the V2-only home root', () => {
    const classic = '<html data-ui-theme="classic"><body><main data-home-desktop><input id="tool-filter"><span id="tool-filter-count"></span></main></body></html>'
    expect(check('panel-home-tools', classic, '/home')).toEqual([])
    expect(check('panel-home-desktop-filter', classic, '/home')).toEqual([])
    expect(check('panel-home-desktop-filter', classic.replace('<input id="tool-filter">', ''), '/home')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'hook', name: '#tool-filter' })]))
  })
  const composeAttachments = (tag: string, role: string) => '<section data-compose-attachments><button type="button" data-compose-attachment-open></button><input type="file" multiple data-compose-attachment-input><ul data-compose-attachment-list></ul><' + tag + ' role="' + role + '" data-compose-attachment-status></' + tag + '><template data-xp-template="mail-compose-attachment-row"><li><bdi data-xp-slot="name"></bdi><bdi data-xp-slot="size"></bdi><button type="button" data-xp-slot="remove"></button></li></template><template data-xp-template="mail-compose-attachment-dismiss"><button type="button" data-xp-slot="label"></button></template></section>'
  it.each(['p', 'span'])('accepts the actual %s compose attachment status with its status role', tag => {
    expect(check('mail-compose-attachments-root', composeAttachments(tag, 'status'), '/mail/compose', 'xmail')).toEqual([])
  })
  it.each([['div', 'status'], ['p', 'alert']])('rejects compose attachment status with tag %s and role %s', (tag, role) => {
    expect(check('mail-compose-attachments-root', composeAttachments(tag, role), '/mail/compose', 'xmail')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'element', name: '[data-compose-attachment-status]' })]))
  })
})