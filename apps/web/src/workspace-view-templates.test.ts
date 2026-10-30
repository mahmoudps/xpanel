// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { cloneViewRecord, viewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'

let testDom: EnvironmentReturn | undefined
beforeEach(async () => {
  testDom = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://whm.example.test/whm', runScripts: 'outside-only' } })
})
afterEach(async () => {
  try { document.body.replaceChildren() }
  finally { await testDom?.teardown(globalThis); testDom = undefined }
})
const root = (html: string) => { const element = document.createElement('section'); element.innerHTML = html; return element }
describe('selected-theme view records', () => {
  it('lets each theme choose semantic columns while filling untrusted values as text', () => {
    for (const [theme, fields] of [['classic', ['name', 'plan']], ['v2', ['name']]] as const) {
      const host = root(`<template data-xp-template="row"><tr class="${theme}-row">${fields.map(key => `<td><bdi dir="ltr" data-xp-slot="${key}"></bdi></td>`).join('')}</tr></template>`)
      const row = cloneViewRecord(host, 'row', 'tr', { name: '<img src=x>', plan: 'Gold', unused: 'never rendered' })
      expect(row.className).toBe(`${theme}-row`)
      expect(row.querySelectorAll('td')).toHaveLength(fields.length)
      expect(row.querySelector('img')).toBeNull()
      expect(row.textContent).toContain('<img src=x>')
      expect(row.textContent).not.toContain('never rendered')
    }
  })
  it('rejects missing, duplicate and unknown slots without a fallback renderer', () => {
    for (const [body, error] of [['<tr></tr>', 'view_record_slots_unavailable'], ['<tr><td data-xp-slot="missing"></td></tr>', 'view_record_slot_unavailable'], ['<tr><td data-xp-slot="name"></td><td data-xp-slot="name"></td></tr>', 'client_template_slot_unavailable']]) {
      expect(() => cloneViewRecord(root(`<template data-xp-template="row">${body}</template>`), 'row', 'tr', { name: 'Alice' })).toThrow(error)
    }
  })
  it('retains the canonical missing/ambiguous template and wrong-root guards', () => {
    expect(() => cloneViewRecord(root(''), 'row', 'tr', { name: 'Alice' })).toThrow('client_template_unavailable')
    expect(() => cloneViewRecord(root('<template data-xp-template="row"><p data-xp-slot="name"></p></template>'), 'row', 'tr', { name: 'Alice' })).toThrow('invalid_client_template_root')
    expect(() => cloneViewRecord(root('<template data-xp-template="row"><tr data-xp-slot="name"></tr></template>'.repeat(2)), 'row', 'tr', { name: 'Alice' })).toThrow('client_template_unavailable')
  })
  it('locates actions only inside the selected clone with an exact semantic tag', () => {
    const host = root('<button data-xp-action="remove">foreign</button><template data-xp-template="row"><tr><td data-xp-slot="name"></td><td><button data-xp-action="remove" class="v2-btn">remove</button></td></tr></template>')
    const row = cloneViewRecord(host, 'row', 'tr', { name: 'Alice' })
    expect(viewAction(row, 'remove').className).toBe('v2-btn')
    expect(() => viewAction(row, 'remove', 'a')).toThrow('view_action_unavailable')
    expect(() => viewAction(row, 'foreign')).toThrow('view_action_unavailable')
  })
  it('rejects ambiguous actions and malformed selector names', () => {
    const host = root('<div><button data-xp-action="remove"></button><button data-xp-action="remove"></button></div>')
    expect(() => viewAction(host, 'remove')).toThrow('view_action_unavailable')
    expect(() => viewAction(host, 'remove"]')).toThrow('invalid_view_action_name')
  })
  it('serializes a complete binding without markup injection or external runtime references', () => {
    const read = new Function(`${VIEW_RECORD_HELPERS};return {cloneViewRecord,viewAction}`)() as { cloneViewRecord: typeof cloneViewRecord; viewAction: typeof viewAction }
    const host = root('<template data-xp-template="empty"><tr><td colspan="5" data-xp-slot="message"></td></tr></template>')
    const row = read.cloneViewRecord(host, 'empty', 'tr', { message: 'Not read' })
    expect(row.querySelector('td')?.colSpan).toBe(5)
    expect(VIEW_RECORD_HELPERS).not.toContain('innerHTML')
  })
})
