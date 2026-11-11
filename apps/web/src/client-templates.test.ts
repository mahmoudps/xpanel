// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { clientTemplate, clientTemplateSlot, cloneClientTemplate } from './client-templates.ts'

afterEach(() => document.body.replaceChildren())

describe('workspace-owned client templates', () => {
  it('clones the theme markup without altering its prototype or another workspace', () => {
    document.body.innerHTML = '<section id="one"><template data-xp-template="row"><button type="button" class="one"><span aria-hidden="true">+</span><span data-xp-slot="label"></span></button></template></section><section id="two"><template data-xp-template="row"><button type="button" class="two" data-xp-slot="label"></button></template></section>'
    const root = document.getElementById('one')!, template = clientTemplate(root, 'row')
    const clone = cloneClientTemplate(template, 'button', ['label'])
    clientTemplateSlot(clone, 'label').textContent = '<img src=x onerror=alert(1)>'
    expect(clone.className).toBe('one')
    expect(clone.querySelector('[aria-hidden]')!.textContent).toBe('+')
    expect(clone.querySelector('img')).toBeNull()
    expect(template.content.textContent).toBe('+')
    expect(clientTemplate(document.getElementById('two')!, 'row').content.firstElementChild!.className).toBe('two')
  })

  it('refuses missing, duplicate and selector-injected template names', () => {
    document.body.innerHTML = '<section><template data-xp-template="row"><tr></tr></template><template data-xp-template="row"><tr></tr></template></section>'
    const root = document.querySelector('section')!
    expect(() => clientTemplate(root, 'missing')).toThrow('client_template_unavailable')
    expect(() => clientTemplate(root, 'row')).toThrow('client_template_unavailable')
    expect(() => clientTemplate(root, 'row"]')).toThrow('invalid_client_template_name')
  })

  it.each([
    '<tr><td data-xp-slot="label"></td></tr><tr></tr>',
    '<div data-xp-slot="label"></div>',
    'unowned text<tr><td data-xp-slot="label"></td></tr>',
    '<tr><td></td></tr>',
    '<tr><td data-xp-slot="label"></td><td data-xp-slot="label"></td></tr>',
  ])('refuses malformed row roots and ambiguous or missing slots (%s)', markup => {
    document.body.innerHTML = `<section><template data-xp-template="row">${markup}</template></section>`
    const template = clientTemplate(document.querySelector('section')!, 'row')
    expect(() => cloneClientTemplate(template, 'tr', ['label'])).toThrow()
  })

  it('allows a root label and enforces the required semantic element type', () => {
    document.body.innerHTML = '<section><template data-xp-template="action"><button type="button" data-xp-slot="label"></button></template></section>'
    const clone = cloneClientTemplate(clientTemplate(document.querySelector('section')!, 'action'), 'button', ['label'])
    expect(clientTemplateSlot(clone, 'label', 'button')).toBe(clone)
    expect(() => clientTemplateSlot(clone, 'label', 'time')).toThrow('client_template_slot_unavailable')
  })
  it('gives the popover of each cloned row its own id and keeps its trigger pointed at it', () => {
    document.body.innerHTML = '<section><template data-xp-template="row"><tr id="keep"><td data-xp-slot="name"></td><td><button type="button" popovertarget="row-menu" aria-controls="row-menu" aria-haspopup="menu">More</button><ul id="row-menu" role="menu" popover><li role="none"><button type="button" role="menuitem" aria-controls="other">Edit</button></li></ul></td></tr></template>'
      + '<template data-xp-template="plain"><tr id="plain-row"><td data-xp-slot="name" id="plain-cell"></td></tr></template></section>'
    const section = document.querySelector('section')!
    const rows = [1, 2].map(() => cloneClientTemplate(clientTemplate(section, 'row'), 'tr', ['name']))
    const ids = rows.map(row => row.querySelector('[popover]')!.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every(id => /^row-menu-\d+$/.test(id))).toBe(true)
    rows.forEach((row, index) => {
      const trigger = row.querySelector('[popovertarget]')!
      expect([trigger.getAttribute('popovertarget'), trigger.getAttribute('aria-controls')]).toEqual([ids[index], ids[index]])
      expect(row.querySelector('[role="menuitem"]')!.getAttribute('aria-controls')).toBe('other')
      expect(row.id).toBe('keep')
    })
    expect(clientTemplate(section, 'row').content.querySelector('[popover]')!.id).toBe('row-menu')
    const plain = cloneClientTemplate(clientTemplate(section, 'plain'), 'tr', ['name'])
    expect([plain.id, plain.querySelector('td')!.id]).toEqual(['plain-row', 'plain-cell'])
  })
})
