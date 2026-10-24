import type { RenderedFile } from '@xpanel/core'
import type { AgentExecutor } from '../executor.ts'

const UPGRADE_MAP = `map $http_upgrade $xpanel_connection_upgrade {
    default upgrade;
    '' close;
}
`

interface ServerSpan {
  bodyStart: number
  body: string
}

const serverSpans = (config: string): ServerSpan[] => {
  const opener = /\bserver\s*\{/g
  const spans: ServerSpan[] = []
  let found: RegExpExecArray | null
  while ((found = opener.exec(config)) !== null) {
    let depth = 1
    let index = found.index + found[0].length
    const bodyStart = index
    while (index < config.length && depth > 0) {
      const char = config[index]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      index += 1
    }
    spans.push({ bodyStart, body: config.slice(bodyStart, index - 1) })
    opener.lastIndex = index
  }
  return spans
}

/** nginx -T sections. Each body is the file as nginx read it. */
export const nginxConfigFiles = (dump: string): Array<{ path: string; body: string }> => {
  const files: Array<{ path: string; body: string }> = []
  const parts = dump.split(/^# configuration file /m)
  for (const part of parts) {
    const nl = part.indexOf('\n')
    if (nl < 0) continue
    const path = part.slice(0, nl).trim().replace(/:$/, '')
    if (!path.startsWith('/')) continue
    files.push({ path, body: part.slice(nl + 1) })
  }
  return files
}

/**
 * Gives the mail listener (2096) the same upgrade headers as the panel listeners.
 * A block that already forwards Upgrade is left alone. Returns null when nothing changes.
 */
export const rewriteMailWebsocketConfig = (config: string, dumpHasUpgradeMap: boolean): string | null => {
  let next = config
  let changed = false
  for (const span of [...serverSpans(config)].reverse()) {
    if (!/\blisten\s+[^;]*\b2096\b[^;]*;/i.test(span.body)) continue
    if (!/proxy_set_header\s+Upgrade\s+""\s*;/.test(span.body)) continue
    const rewritten = span.body
      .replace(/proxy_set_header\s+Upgrade\s+""\s*;/, 'proxy_set_header Upgrade $http_upgrade;')
      .replace(/proxy_set_header\s+Connection\s+""\s*;/, 'proxy_set_header Connection $xpanel_connection_upgrade;')
    if (rewritten === span.body) continue
    next = `${next.slice(0, span.bodyStart)}${rewritten}${next.slice(span.bodyStart + span.body.length)}`
    changed = true
  }
  if (!changed) return null
  if (!dumpHasUpgradeMap && !/\bmap\s+\$http_upgrade\s+\$xpanel_connection_upgrade\b/.test(config)) {
    next = `${UPGRADE_MAP}\n${next}`
  }
  return next
}

const backupStamp = (): string => new Date().toISOString().replace(/[:.]/g, '')

const nginxDump = async (executor: AgentExecutor): Promise<string> => {
  for (const bin of ['/usr/sbin/nginx', '/usr/bin/nginx']) {
    try {
      const result = await executor.runCommand([bin, '-T'])
      const text = `${result.stdout}\n${result.stderr}`
      if (text.includes('configuration file') || text.includes('server')) return text
    } catch { /* The other nginx path may exist. */ }
  }
  return ''
}

const nginxOk = async (executor: AgentExecutor): Promise<boolean> => {
  for (const bin of ['/usr/sbin/nginx', '/usr/bin/nginx']) {
    try {
      const result = await executor.runCommand([bin, '-t'])
      if (result.ok) return true
    } catch { /* Try the other binary. */ }
  }
  return false
}

/**
 * Patches the installed mail server block so `/api/ws` is upgraded, tests nginx,
 * and reloads. A failed test restores the previous file.
 */
export const enableMailWebsocketProxy = async (executor: AgentExecutor): Promise<boolean> => {
  const dump = await nginxDump(executor)
  if (!dump) return false
  const hasMap = /\bmap\s+\$http_upgrade\s+\$xpanel_connection_upgrade\b/.test(dump)
  let changed = false
  for (const file of nginxConfigFiles(dump)) {
    if (!file.path.startsWith('/etc/nginx/')) continue
    const existing = await executor.readFile(file.path)
    const source = existing ?? file.body
    const rewritten = rewriteMailWebsocketConfig(source, hasMap)
    if (!rewritten || rewritten === source) continue
    const owned: RenderedFile = { path: file.path, content: rewritten, mode: 0o644, owner: 'root', group: 'root' }
    if (existing !== null) {
      await executor.writeFile({
        path: `${file.path}.bak.${backupStamp()}`,
        content: existing,
        mode: 0o644,
        owner: 'root',
        group: 'root',
      })
    }
    await executor.writeFile(owned)
    if (!await nginxOk(executor)) {
      if (existing !== null) {
        await executor.writeFile({ path: file.path, content: existing, mode: 0o644, owner: 'root', group: 'root' })
      }
      continue
    }
    try {
      await executor.runAction({ kind: 'systemd', verb: 'reload', unit: 'nginx.service' })
    } catch { /* nginx -t passed. A missing unit can be reloaded by the operator. */ }
    changed = true
  }
  return changed
}
