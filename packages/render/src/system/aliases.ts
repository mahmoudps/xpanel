import type { HostAction, RenderedFile } from '@xpanel/core'

export const SYSTEM_ALIASES_PATH = '/etc/aliases'
const BEGIN = '# xpanel-system-mail-begin', END = '# xpanel-system-mail-end'

/**
 * aliases(5) with one managed block for root, nobody and the panel user. Their distribution lines are replaced, every
 * other line stays byte for byte, and a user without a forward keeps no line at all.
 */
export const renderSystemAliases = (forwards: Readonly<Record<string, string | null>>, previous: string | null): { file: RenderedFile; action: HostAction } => {
  const users = Object.keys(forwards), outside = (previous ?? '').replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`), '')
  const kept = outside.split('\n').filter(line => !users.some(user => new RegExp(`^${user}\\s*:`).test(line))).join('\n').replace(/\n*$/, '\n')
  const lines = users.flatMap(user => forwards[user] ? [`${user}: ${forwards[user]}`] : [])
  return {
    file: { path: SYSTEM_ALIASES_PATH, content: `${kept === '\n' ? '' : kept}${BEGIN}\n${lines.join('\n')}${lines.length ? '\n' : ''}${END}\n`, mode: 0o644, owner: 'root', group: 'root' },
    action: { kind: 'exec', argv: ['/usr/bin/newaliases'] },
  }
}
