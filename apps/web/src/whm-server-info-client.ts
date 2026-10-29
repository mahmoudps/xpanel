/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { xwhmPageAdapters } from './pages/xwhm-adapters.ts'

export interface WhmServerInfoView { load: [number, number, number]; memory: { availableBytes: number; totalBytes: number }; disk: { availableBytes: number; totalBytes: number } }

/** Strict reader for GET /api/server/info (agent /host/info): partial or malformed output is a failed read, never a value. */
export function readWhmServerInfo(value: unknown): WhmServerInfoView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const load = (item: unknown): item is number => typeof item === 'number' && Number.isFinite(item) && item >= 0
  const bytes = (item: unknown): { availableBytes: number; totalBytes: number } => {
    if (!object(item) || ![item.availableBytes, item.totalBytes].every(entry => Number.isSafeInteger(entry) && (entry as number) >= 0) || (item.availableBytes as number) > (item.totalBytes as number)) throw new Error('invalid_server_info')
    return { availableBytes: item.availableBytes as number, totalBytes: item.totalBytes as number }
  }
  if (!object(value) || !object(value.load) || ![value.load.load1, value.load.load5, value.load.load15].every(load)) throw new Error('invalid_server_info')
  return { load: [value.load.load1 as number, value.load.load5 as number, value.load.load15 as number], memory: bytes(value.memory), disk: bytes(value.disk) }
}

function bindWhmServerInfo(path: string): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-host-info]').forEach(root => {
    if (root.dataset.hostInfoBound === 'true') return
    root.dataset.hostInfoBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-host-info-status]')
    const values = { load: root.querySelector<HTMLElement>('[data-host-load]'), memory: root.querySelector<HTMLElement>('[data-host-memory]'), disk: root.querySelector<HTMLElement>('[data-host-disk]') }
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
    const note = (state: string, message: string): void => { if (!status) return; status.hidden = !message; status.dataset.state = state; status.setAttribute('role', state === 'failed' ? 'alert' : 'status'); status.textContent = message }
    const show = (key: keyof typeof values, text: string, technical: boolean): void => { const node = values[key]; if (!node) return; node.textContent = text; if (technical) node.dir = 'ltr'; else node.removeAttribute('dir') }
    const megabytes = (count: number): string => String(Math.round(count / 1048576)) + ' MB'
    const failed = (message: string): void => { for (const key of ['load', 'memory', 'disk'] as const) show(key, t('Unavailable'), false); note('failed', message) }
    if (typeof request !== 'function') { failed(t('Server information is unavailable here. Nothing was read.')); return }
    root.setAttribute('aria-busy', 'true')
    request('GET', path).then(readWhmServerInfo).then(view => {
      show('load', view.load.join(' '), true)
      show('memory', megabytes(view.memory.availableBytes) + ' / ' + megabytes(view.memory.totalBytes), true)
      show('disk', megabytes(view.disk.availableBytes) + ' / ' + megabytes(view.disk.totalBytes), true)
      note('read', '')
    }, (error: unknown) => {
      const code = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined
      failed(code === 401 || code === 403 ? t('Server information requires root authorization. Nothing was read.') : t('Server information could not be read. No measurements are shown.'))
    }).finally(() => root.setAttribute('aria-busy', 'false'))
  })
}

export const WHM_SERVER_INFO_CLIENT_BINDING = `(()=>{const readWhmServerInfo=${readWhmServerInfo.toString()};const bind=${bindWhmServerInfo.toString()};return ()=>bind(${JSON.stringify(xwhmPageAdapters.serverInfo.read.path)});})()`
