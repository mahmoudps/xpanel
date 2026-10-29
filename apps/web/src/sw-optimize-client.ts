/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { readSwOptimizeView } from '../../../packages/os/src/sw-optimize-command.ts'
export { readSwOptimizeView }

function bindSwOptimize(parse: typeof readSwOptimizeView): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
  const blocked = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  document.querySelectorAll<HTMLElement>('[data-sw-optimize]').forEach(root => {
    if (root.dataset.swBound === 'true') return
    root.dataset.swBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-sw-optimize-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-sw-optimize-refresh]'), domains = root.querySelector<HTMLElement>('[data-sw-optimize-domains]'), types = root.querySelector<HTMLElement>('[data-sw-optimize-types]')
    if (!status || !refresh || !domains || !types) return
    const admitted = (): boolean => root.isConnected && root.dataset.swCanRead === 'true' && !root.closest(blocked) && typeof transport === 'function'
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const fact = (key: string, text: string, human: boolean): void => { const node = root.querySelector<HTMLElement>('[data-sw-optimize-' + key + ']'); if (node) { node.textContent = text; node.toggleAttribute('data-human', human) } }
    let busy = false
    const paint = (view: ReturnType<typeof readSwOptimizeView> | null): void => {
      const p = view?.policy ?? null
      fact('compression', p ? (p.compression === 'on' ? t('On') : t('Off')) : t('Not read'), true)
      fact('min', p?.minLength !== null && p?.minLength !== undefined ? t('{bytes, plural, one {# byte} other {# bytes}}', { bytes: p.minLength }) : t('Not read'), true)
      fact('proxied', p ? (p.proxied.includes('off') ? t('No') : p.proxied.join(' ')) : t('Not read'), !p || p.proxied.includes('off'))
      fact('cache', p ? (p.cache.configured ? (p.cache.maxSize ? t('On, up to {size}', { size: p.cache.maxSize }) : t('On')) : t('Off')) : t('Not read'), true)
      types.textContent = ''
      if (p) for (const [index, type] of p.types.entries()) { if (index) types.append(', '); const value = document.createElement('bdi'); value.dir = 'ltr'; value.textContent = type; types.append(value) }
      else types.textContent = t('Not read')
      domains.textContent = ''
      for (const domain of view?.domains ?? []) {
        const row = document.createElement('tr'), name = document.createElement('td'), compression = document.createElement('td'), cache = document.createElement('td'), value = document.createElement('bdi')
        value.dir = 'ltr'; value.textContent = domain.name; name.append(value)
        compression.textContent = !p ? t('Not read') : p.compression === 'on' ? t('Server policy: on') : t('Server policy: off')
        cache.textContent = !p ? t('Not read') : domain.suspended ? t('Not cached: suspended') : domain.redirect ? t('Not cached: redirect') : p.cache.configured ? t('Cached when eligible') : t('Off')
        row.append(name, compression, cache); domains.append(row)
      }
      if (!domains.childElementCount) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 3; cell.textContent = view ? t('This account has no domains.') : t('Not read.'); row.append(cell); domains.append(row) }
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; refresh.disabled = true; note('reading', t('Reading the optimization policy…'))
      try {
        const view = parse(await transport!('GET', '/api/account/optimize'))
        if (!admitted()) return
        paint(view)
        note(view.state === 'read' ? 'read' : 'unavailable', view.state === 'read' ? t('Policy read from the managed edge configuration. Per-site rules and purge are unavailable.')
          : view.reason === 'unmanaged-edge-config' ? t('The edge configuration is not managed by xPanel, so its policy is not shown.') : view.reason === 'invalid-edge-config' ? t('The edge configuration could not be verified. No policy is shown.') : t('The edge configuration cannot be read on this server. No policy is shown.'))
      } catch { if (admitted()) { paint(null); note('failed', t('The optimization policy could not be verified. Read again; nothing was changed.')) } }
      finally { busy = false; refresh.disabled = !admitted() }
    }
    if (!admitted()) { refresh.disabled = true; note('unavailable', t('Website optimization is unavailable here. Nothing was read or changed.')); return }
    refresh.addEventListener('click', () => { void load() })
    void load()
  })
}
export const SW_OPTIMIZE_CLIENT_BINDING = `(()=>{const parse=${readSwOptimizeView.toString()};const bind=${bindSwOptimize.toString()};return ()=>bind(parse);})()`
