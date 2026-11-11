/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import { LIST_FILTER_CLIENT_SCRIPT } from '../../../../../list-filter-client.ts'
import { renderV2WhmFirewall } from './firewall.ts'
import { renderV2WhmFirewallClientTemplates } from './firewall-client-templates.ts'

const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const rule = (id: string, kind: 'port' | 'ip' | 'prefix-list', action: 'accept' | 'drop' | 'reject', port: string) => ({ id, kind, action, protocol: 'tcp' as const, port, source: null, forwardTo: null, list: kind === 'prefix-list' ? 'feed' : null, comment: id, enabled: true })
const rules = [rule('web', 'port', 'accept', '443'), rule('mail', 'port', 'drop', '25'), rule('office', 'ip', 'reject', '22'), rule('feed', 'prefix-list', 'drop', '80')]

afterEach(() => { document.body.replaceChildren() })

describe('v2 firewall list filter', () => {
  it('filters each panel by search and, where rows carry an action, by the action chips', () => {
    document.body.innerHTML = renderV2WhmFirewall({ principal: { kind: 'root', id: 'r1', username: 'root' }, catalog, firewallRules: rules })
    new Function(LIST_FILTER_CLIENT_SCRIPT)()
    const panel = (kind: string) => document.querySelector<HTMLElement>(`section[data-whm-firewall-panel="${kind}"][data-list-filter]`)!
    const shown = (kind: string) => [...panel(kind).querySelectorAll<HTMLElement>('tr[data-list-row]')].filter(row => !row.hidden).map(row => row.dataset.listAction)
    expect(shown('port')).toEqual(['accept', 'drop'])
    panel('port').querySelector<HTMLButtonElement>('button[data-list-filter-value="drop"]')!.click()
    expect(shown('port')).toEqual(['drop'])
    expect(panel('port').querySelector('[data-list-filter-value="drop"]')!.getAttribute('aria-pressed')).toBe('true')
    panel('port').querySelector<HTMLButtonElement>('button[data-list-filter-value="reject"]')!.click()
    expect(panel('port').querySelector<HTMLElement>('[data-list-filter-empty]')!.hidden).toBe(false)
    panel('port').querySelector<HTMLButtonElement>('button[data-list-filter-value=""]')!.click()
    const search = panel('port').querySelector<HTMLInputElement>('[data-list-filter-search]')!
    search.value = 'mail'; search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(shown('port')).toEqual(['drop'])
    for (const kind of ['port', 'ip', 'icmp']) expect(panel(kind).querySelector('[data-list-filter-key="action"]')).not.toBeNull()
    for (const kind of ['forward', 'prefix-list', 'banned']) {
      expect(panel(kind).querySelector('[data-list-filter-search]')).not.toBeNull()
      expect(panel(kind).querySelector('[data-list-filter-key]')).toBeNull()
    }
    expect(panel('prefix-list').querySelector('tr[data-list-row]')!.hasAttribute('data-list-action')).toBe(false)
  })

  it('admits every client-painted rule row to the filter', () => {
    const html = renderV2WhmFirewallClientTemplates()
    for (const kind of ['port', 'ip', 'forward', 'prefix', 'ban']) expect(html).toContain(`<template data-xp-template="firewall-${kind}-row"><tr data-list-row>`)
  })
})
