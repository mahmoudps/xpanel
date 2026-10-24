import { readFileSync } from 'node:fs'
import type { RenderedFile } from '@xpanel/core'
import type { AgentExecutor } from './executor.ts'

const ORIGIN_KEYS = ['XPANEL_WHM_PUBLIC_ORIGIN', 'XPANEL_PANEL_PUBLIC_ORIGIN', 'XPANEL_MAIL_PUBLIC_ORIGIN'] as const
const RUNTIME_PATH = '/etc/xpanel/runtime.env'
const API_ENV_PATH = '/etc/xpanel/api.env'

const clean = (value: string): string | null => {
  const text = value.trim()
  if (!text || /[\u0000-\u001f\u007f]/.test(text) || text.length > 300) return null
  return text
}

/** KEY=value rows. Comments and control characters are skipped. */
export const parseEnvAssignments = (text: string): Map<string, string> => {
  const rows = new Map<string, string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    const safe = clean(value)
    if (safe) rows.set(key, safe)
  }
  return rows
}

/**
 * Copies public-origin keys from api.env into runtime.env. Other runtime lines
 * stay. Returns null when the runtime file already has the same values.
 */
export const mergeOriginIntoRuntime = (runtime: string, api: string): string | null => {
  const fromApi = parseEnvAssignments(api)
  const lines = runtime.split('\n')
  const present = new Set<string>()
  let changed = false
  const next = lines.map(line => {
    const match = /^\s*(XPANEL_(?:WHM|PANEL|MAIL)_PUBLIC_ORIGIN)\s*=\s*(.*)$/.exec(line)
    if (!match?.[1]) return line
    present.add(match[1])
    const wanted = fromApi.get(match[1])
    if (!wanted) return line
    const replacement = `${match[1]}=${wanted}`
    if (line.trim() === replacement) return line
    changed = true
    return replacement
  })
  for (const key of ORIGIN_KEYS) {
    const wanted = fromApi.get(key)
    if (!wanted || present.has(key)) continue
    changed = true
    const row = `${key}=${wanted}`
    if (next.length > 0 && next[next.length - 1] === '') next.splice(next.length - 1, 0, row)
    else next.push(row)
  }
  if (!changed) return null
  const text = next.join('\n')
  return text.endsWith('\n') ? text : `${text}\n`
}

const backupStamp = (): string => new Date().toISOString().replace(/[:.]/g, '')

/** Writes origin keys into the reconciler-owned runtime env. A missing runtime file is left alone. */
export const syncRuntimePublicOrigin = async (executor: AgentExecutor): Promise<boolean> => {
  const runtime = await executor.readFile(RUNTIME_PATH)
  const api = await executor.readFile(API_ENV_PATH)
  if (runtime === null || api === null) return false
  const merged = mergeOriginIntoRuntime(runtime, api)
  if (merged === null) return false
  const backup: RenderedFile = {
    path: `${RUNTIME_PATH}.bak.${backupStamp()}`,
    content: runtime,
    mode: 0o640,
    owner: 'root',
    group: 'xpanel',
  }
  await executor.writeFile(backup)
  await executor.writeFile({ path: RUNTIME_PATH, content: merged, mode: 0o640, owner: 'root', group: 'xpanel' })
  return true
}

/**
 * Public origin for panel SNI. The process environment wins, then runtime.env,
 * then api.env. The agent reads the file so a merge is visible before restart.
 */
export const readPublicOriginSync = (
  env: NodeJS.ProcessEnv = process.env,
  files: readonly string[] = [RUNTIME_PATH, API_ENV_PATH],
): string | null => {
  for (const key of ORIGIN_KEYS) {
    const value = clean(env[key] ?? '')
    if (value) return value
  }
  for (const path of files) {
    try {
      const parsed = parseEnvAssignments(readFileSync(path, 'utf8'))
      for (const key of ORIGIN_KEYS) {
        const value = parsed.get(key)
        if (value) return value
      }
    } catch { /* A missing env file is the next source. */ }
  }
  return null
}
