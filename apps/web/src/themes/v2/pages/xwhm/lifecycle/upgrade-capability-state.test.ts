import { expect, it } from 'vitest'
import { parseMarkup } from '../../../../markup.ts'
import { renderV2UpgradePage } from './upgrade.ts'

const states = (['en', 'ar'] as const).flatMap(locale => [
  { locale, canRead: false, canManage: true },
  { locale, canRead: true, canManage: false },
  { locale, canRead: true, canManage: true },
])

it.each(states)('projects upgrade read admission independently of manage permission ($locale, read=$canRead, manage=$canManage)', { tags: ['unit'] }, state => {
  const hostname = 'private-host.example.test'
  const html = renderV2UpgradePage({ ...state, hostname })
  const nodes = parseMarkup(html).filter(node => node.template < 0)
  const root = nodes.find(node => node.attrs.get('data-whm-detail-route') === '/whm/server/upgrade')
  const workspace = nodes.find(node => node.attrs.has('data-whm-upgrade-workspace'))
  if (!root || !workspace) throw new Error('Missing upgrade workspace')

  expect(root.attrs.get('data-capability-state')).toBe(state.canRead ? 'authorized' : 'unavailable')
  expect(workspace.attrs.get('data-upgrade-can-manage')).toBe(String(state.canRead && state.canManage))
  const controls = nodes.filter(node => ['input', 'select', 'button'].includes(node.tag))
  expect(controls.length).toBeGreaterThan(0)
  expect(controls.every(node => node.attrs.has('disabled'))).toBe(true)
  if (state.canRead) expect(html).toContain(hostname)
  else expect(html).not.toContain(hostname)
})
