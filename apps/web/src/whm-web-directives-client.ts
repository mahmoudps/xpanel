/// <reference lib="dom" />
import { defaultServerWebSettings } from '@xpanel/core'
import type { ServerWebSettings } from '@xpanel/core'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { frameAccess as canonicalFrameAccess, withFrameRequest } from './read-only-frame.ts'
const frameAccess = canonicalFrameAccess

const WEB_DIRECTIVE_DEFAULTS = defaultServerWebSettings()
type FormValues = Record<string, string | boolean | string[]>

/** ServerSettings.web from the Global Configuration, DirectoryIndex, memory, compression and Include Editor fields. */
export function buildWebDirectives(values: FormValues): Record<string, unknown> {
  const text = (key: string): string => { const value = values[key]; if (typeof value !== 'string') throw new Error(key); return value }
  const integer = (key: string, optional = false): number | null => {
    const value = text(key).trim()
    if (optional && value === '') return null
    if (!/^(?:0|[1-9][0-9]{0,7})$/.test(value)) throw new Error(key)
    return Number(value)
  }
  const protocols = values['web.tlsProtocols']
  return {
    timeoutSec: integer('web.timeoutSec'), clientMaxBodyMb: integer('web.clientMaxBodyMb'),
    tlsProtocols: Array.isArray(protocols) ? protocols : [], tlsCiphers: text('web.tlsCiphers').trim(),
    gzip: { enabled: values['web.gzip.enabled'] === true, level: integer('web.gzip.level') },
    directoryIndex: text('web.directoryIndex').split(/[\r\n,\s]+/).filter(Boolean),
    rlimitMemMb: integer('web.rlimitMemMb', true), rlimitCpuSec: integer('web.rlimitCpuSec', true),
    includes: { apachePreMain: text('web.includes.apachePreMain'), apachePreVhost: text('web.includes.apachePreVhost'), apachePostVhost: text('web.includes.apachePostVhost'), nginxHttp: text('web.includes.nginxHttp') },
  }
}

/** Field text for saved directives, or the defaults while none are saved. */
export function webDirectiveFieldValues(web: unknown, defaults: ServerWebSettings): FormValues {
  const w = (web && typeof web === 'object' && !Array.isArray(web) ? web : defaults) as ServerWebSettings
  return {
    'web.timeoutSec': String(w.timeoutSec), 'web.clientMaxBodyMb': String(w.clientMaxBodyMb), 'web.tlsProtocols': [...w.tlsProtocols], 'web.tlsCiphers': String(w.tlsCiphers),
    'web.gzip.enabled': w.gzip.enabled === true, 'web.gzip.level': String(w.gzip.level), 'web.directoryIndex': w.directoryIndex.join('\n'),
    'web.rlimitMemMb': w.rlimitMemMb === null ? '' : String(w.rlimitMemMb), 'web.rlimitCpuSec': w.rlimitCpuSec === null ? '' : String(w.rlimitCpuSec),
    'web.includes.apachePreMain': w.includes.apachePreMain, 'web.includes.apachePreVhost': w.includes.apachePreVhost, 'web.includes.apachePostVhost': w.includes.apachePostVhost, 'web.includes.nginxHttp': w.includes.nginxHttp,
  }
}

function bindWhmWebDirectives(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLFormElement>('[data-web-directives-form]').forEach(root => {
    const form = root
    if (form.dataset.webDirectivesBound === 'true') return
    form.dataset.webDirectivesBound = 'true'
    // The saved directives are rendered by the server; saving needs the manage flag outside a read-only frame.
    const access = frameAccess(root, 'data-web-directives-can-read', 'data-web-directives-can-manage'), request = access.request
    const status = form.querySelector<HTMLElement>('[data-web-directives-status]'), submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')
    const controls = (): (HTMLInputElement | HTMLTextAreaElement)[] => [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[name],textarea[name]')]
    const admitted = (): boolean => access.writable()
    let busy = false
    const note = (state: string, message: string): void => { if (!status) return; status.hidden = false; status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'unknown'].includes(state) ? 'alert' : 'status') }
    const values = (): FormValues => {
      const result: FormValues = { 'web.tlsProtocols': [] }
      for (const control of controls()) {
        if (control instanceof HTMLInputElement && control.type === 'checkbox') {
          if (control.name === 'web.tlsProtocols') { if (control.checked) (result['web.tlsProtocols'] as string[]).push(control.value) } else result[control.name] = control.checked
        } else result[control.name] = control.value
      }
      return result
    }
    const fill = (next: FormValues): void => {
      for (const control of controls()) {
        const value = next[control.name]
        if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = Array.isArray(value) ? value.includes(control.value) : value === true
        else if (typeof value === 'string') control.value = value
      }
    }
    const lock = (on: boolean): void => { for (const control of controls()) control.disabled = on || !admitted(); if (submit) submit.disabled = on || !admitted(); form.setAttribute('aria-busy', String(on)) }
    if (!admitted()) { lock(true); return }
    form.addEventListener('submit', event => {
      event.preventDefault()
      void (async () => {
        if (busy || !admitted() || !request || !form.reportValidity()) return
        let web: Record<string, unknown>
        try { web = buildWebDirectives(values()) } catch { note('failed', t('Enter whole numbers in the number fields. Nothing was sent.')); return }
        busy = true; lock(true); note('saving', t('Saving the directives, then testing them with nginx -t and apachectl configtest…'))
        let sent = false
        try {
          const current = await request('GET', '/api/server/settings') as { settings?: Record<string, unknown> | null }
          if (!current?.settings || typeof current.settings.hostname !== 'string') throw new Error('unread')
          sent = true
          const result = await request('PUT', '/api/server/settings', { ...current.settings, web, markSetupComplete: false }) as { settings?: { web?: unknown }; reconcile?: { status?: string } | null }
          if (JSON.stringify(result?.settings?.web) !== JSON.stringify(web)) throw new Error('unverified')
          fill(webDirectiveFieldValues(result.settings!.web, WEB_DIRECTIVE_DEFAULTS))
          const outcome = result.reconcile?.status
          note(outcome === 'applied' || outcome === 'noop' ? 'saved' : 'unknown', outcome === 'applied' ? t('Saved. Both configuration tests passed and the web servers were reloaded with the new directives.')
            : outcome === 'noop' ? t('Saved. The running configuration already matched these directives.')
              : result.reconcile === null ? t('Saved. No host agent is connected, so the directives are not applied yet.') : t('Saved, but the apply result could not be confirmed. Review the generations before retrying.'))
          window.dispatchEvent(new CustomEvent('xpanel:workspace-stored', { detail: { form: 'server-settings' } }))
        } catch (error) {
          const problem = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}, details = problem.details ?? {}
          if (problem.code === 'CONFIG_TEST_FAILED') note('failed', t('The {test} test refused the new directives. The previous directives stay saved and running; fix the fields and try again.', { test: String(details.failedTest ?? '') }) + (typeof details.error === 'string' ? '\n' + details.error : ''))
          else if (!sent || details.stateChanged === false) note('failed', t('The directives were not saved. Nothing was changed; check the fields and try again.'))
          else note('unknown', t('The outcome is unknown. Read the saved settings and generations before retrying.'))
        } finally { busy = false; lock(false) }
      })()
    })
  })
}

export const WHM_WEB_DIRECTIVES_CLIENT_BINDING = withFrameRequest(`(()=>{const WEB_DIRECTIVE_DEFAULTS=${JSON.stringify(WEB_DIRECTIVE_DEFAULTS)};const buildWebDirectives=${buildWebDirectives.toString()};const webDirectiveFieldValues=${webDirectiveFieldValues.toString()};return ${bindWhmWebDirectives.toString()};})()`)
