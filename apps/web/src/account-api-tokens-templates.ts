/// <reference lib="dom" />
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot, cloneClientTemplate = canonicalCloneClientTemplate

/** Classic may supply its classes; V2 owns equivalent finite prototypes in its own module boundary. */
export function accountApiTokenClientTemplates(classes: { buttonClass: string; badgeClass: string }): string {
  for (const value of Object.values(classes)) if (!/^[A-Za-z0-9_ -]{0,160}$/.test(value)) throw new Error('invalid_account_token_template_class')
  const state = (name: string): string => `<template data-xp-template="account-token-state-${name}"><span class="${classes.badgeClass}" data-xp-slot="content"></span></template>`
  return `<template data-xp-template="account-token-row"><tr><td><label><input type="checkbox" data-xp-slot="select" disabled><bdi dir="ltr" data-xp-slot="name"></bdi></label><span data-xp-slot="state"></span></td><td data-xp-slot="scopes"></td><td data-xp-slot="addresses"></td><td data-xp-slot="created"></td><td data-xp-slot="expires"></td><td data-xp-slot="used"></td><td data-xp-slot="actions"></td></tr></template>`
    + `<template data-xp-template="account-token-actions"><div data-xp-slot="content"></div></template>`
    + (['rename', 'revoke'] as const).map(action => `<template data-xp-template="account-token-${action}"><button type="button" class="${classes.buttonClass}" data-xp-slot="content" data-xp-action="${action}" disabled></button></template>`).join('')
    + ['active', 'expired', 'revoked'].map(state).join('')
    + '<template data-xp-template="account-token-empty"><tr><td colspan="7" data-xp-slot="content"></td></tr></template>'
}

/** Every required prototype is workspace-owned, single-rooted and has exactly its typed slots. */
export function assertAccountApiTokenTemplates(root: HTMLElement): void {
  const unsafeTags = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'A', 'SELECT', 'TEXTAREA'])
  const unsafeAttrs = new Set(['data-api-url', 'src', 'href'])
  const contracts = [
    ['account-token-row', 'tr', { select: 'input', name: 'bdi', state: 'span', scopes: 'td', addresses: 'td', created: 'td', expires: 'td', used: 'td', actions: 'td' }],
    ['account-token-actions', 'div', { content: 'div' }],
    ['account-token-rename', 'button', { content: 'button' }],
    ['account-token-revoke', 'button', { content: 'button' }],
    ['account-token-state-active', 'span', { content: 'span' }],
    ['account-token-state-expired', 'span', { content: 'span' }],
    ['account-token-state-revoked', 'span', { content: 'span' }],
    ['account-token-empty', 'tr', { content: 'td' }],
  ] as const
  for (const [name, tag, slots] of contracts) {
    const template = clientTemplate(root, name)
    if (template.closest('[data-account-api-tokens]') !== root) throw new Error('account_token_template_owner_changed')
    const clone = cloneClientTemplate(template, tag, [])
    const present = [...(clone.hasAttribute('data-xp-slot') ? [clone] : []), ...clone.querySelectorAll<HTMLElement>('[data-xp-slot]')]
    if (present.length !== Object.keys(slots).length || present.some(node => !Object.hasOwn(slots, node.getAttribute('data-xp-slot') ?? ''))) throw new Error('account_token_template_slots_unavailable')
    for (const [slot, type] of Object.entries(slots)) clientTemplateSlot(clone, slot, type)
    let inputCount = 0, buttonCount = 0
    for (const stack: Element[] = [clone]; stack.length;) {
      const node = stack.pop()!, nodeTag = node.tagName
      if (unsafeTags.has(nodeTag)) throw new Error('account_token_template_unsafe')
      if (nodeTag === 'INPUT') inputCount++
      else if (nodeTag === 'BUTTON') buttonCount++
      for (let i = 0; i < node.attributes.length; i++) {
        const attrName = node.attributes[i]!.name
        if (/^on/i.test(attrName) || unsafeAttrs.has(attrName)) throw new Error('account_token_template_unsafe')
      }
      for (let child = node.firstElementChild; child; child = child.nextElementSibling) stack.push(child)
    }
    if (name === 'account-token-row') {
      const select = clientTemplateSlot(clone, 'select', 'input')
      if (!(select instanceof HTMLInputElement) || select.type !== 'checkbox' || !select.disabled || clone.children.length !== 7
        || [...clone.children].some(cell => cell.tagName !== 'TD') || clientTemplateSlot(clone, 'name', 'bdi').getAttribute('dir') !== 'ltr'
        || inputCount !== 1 || buttonCount > 0) throw new Error('account_token_row_unavailable')
    } else if (name === 'account-token-rename' || name === 'account-token-revoke') {
      if (!(clone instanceof HTMLButtonElement) || clone.type !== 'button' || !clone.disabled || clone.getAttribute('data-xp-action') !== name.slice('account-token-'.length) || inputCount > 0 || buttonCount !== 1) throw new Error('account_token_action_unavailable')
    } else if (inputCount > 0 || buttonCount > 0) throw new Error('account_token_template_unexpected_control')
    if (name === 'account-token-empty' && (clone.children.length !== 1 || clientTemplateSlot(clone, 'content', 'td').getAttribute('colspan') !== '7')) throw new Error('account_token_empty_unavailable')
  }
}

export function accountApiTokenNode(root: HTMLElement, name: string, tag: string): HTMLElement {
  const template = clientTemplate(root, name)
  if (template.closest('[data-account-api-tokens]') !== root) throw new Error('account_token_template_owner_changed')
  return cloneClientTemplate(template, tag, [])
}

export const ACCOUNT_API_TOKEN_TEMPLATE_BINDING = `const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const assertAccountApiTokenTemplates=${assertAccountApiTokenTemplates.toString()};const accountApiTokenNode=${accountApiTokenNode.toString()};`
