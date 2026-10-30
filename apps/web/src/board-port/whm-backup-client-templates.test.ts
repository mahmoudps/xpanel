import { describe, expect, it } from 'vitest'
import { parseMarkup } from '../themes/markup.ts'
import { classicWhmBackupClientTemplates } from './whm-backup-client-templates.ts'

const hasClass = (value: string | undefined, name: string): boolean => (value ?? '').split(/\s+/).includes(name)

describe('classic backup client templates', () => {
  it('retains the action group inside the cloned pager and each multi-action backup cell', () => {
    const nodes = parseMarkup(classicWhmBackupClientTemplates())
    for (const name of ['pager', 'destination-row', 'run-row']) {
      const template = nodes.findIndex(node => node.attrs.get('data-xp-template') === 'whm-backup-' + name)
      const buttons = nodes.filter(node => node.template === template && node.tag === 'button')
      expect(buttons).toHaveLength(2)
      for (const button of buttons) expect(hasClass(nodes[button.parent]?.attrs.get('class'), 'xp-whm-backup-actions')).toBe(true)
    }
  })
})
