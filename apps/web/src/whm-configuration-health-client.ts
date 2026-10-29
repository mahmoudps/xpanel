/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
import type { ConfigurationHealthView } from '../../agent/src/configuration-health.ts'
import { readConfigurationHealthRepair, readConfigurationHealthView } from '../../agent/src/configuration-health-contract.ts'
export { readConfigurationHealthRepair, readConfigurationHealthView } from '../../agent/src/configuration-health-contract.ts'

function bindWhmConfigurationHealth(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined, parseView: typeof readConfigurationHealthView, parseRepair: typeof readConfigurationHealthRepair): void {
  const t = (message: string, values?: MessageValues) => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-configuration-health]').forEach(root => {
    if (root.dataset.chBound === 'true') return
    root.dataset.chBound = 'true'
    const q = <T extends Element>(selector: string) => root.querySelector<T>(selector)
    const status = q<HTMLElement>('[data-ch-status]'), refresh = q<HTMLButtonElement>('[data-ch-refresh]'), drift = q<HTMLElement>('[data-ch-targets]'), tests = q<HTMLElement>('[data-ch-tests]'), select = q<HTMLSelectElement>('[data-ch-target]'), confirmation = q<HTMLInputElement>('[data-ch-confirm]'), repair = q<HTMLButtonElement>('[data-ch-repair]'), feedback = q<HTMLElement>('[data-ch-feedback]'), reason = q<HTMLElement>('[data-ch-reason]')
    if (!status || !refresh || !drift || !tests || !select || !confirmation || !repair || !feedback || !reason) return
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = () => typeof request === 'function' && root.isConnected && root.dataset.chCanRead === 'true' && !root.closest(denied)
    let view: ConfigurationHealthView | null = null, busy = false, review = false
    const note = (state: string, text: string) => { status.dataset.state = state; status.textContent = text }
    const controls = () => { refresh.disabled = busy || !admitted(); const enabled = !busy && !review && admitted() && root.dataset.chCanRepair === 'true' && view?.canRepair === true && typeof askDialog === 'function'; select.disabled = !enabled; confirmation.disabled = !enabled; repair.disabled = !enabled || !select.value || confirmation.value !== 'REPAIR CONFIGURATION' }
    const bdi = (value: string) => { const node = document.createElement('bdi'); node.dir = 'ltr'; node.textContent = value; return node }
    const cell = (tr: HTMLTableRowElement, value: string, technical = false) => { const td = document.createElement('td'); td.append(technical ? bdi(value) : document.createTextNode(value)); tr.append(td) }
    const paint = () => {
      const facts: Record<string, string> = { generation: view?.generation?.checksum ?? t('Unavailable'), desired: view?.desired?.checksum ?? t('Unavailable'), files: view?.managedFiles === null || !view ? t('Unavailable') : String(view.managedFiles), observed: view ? formatDisplayDateTime(view.observedAt) : t('Not read') }
      for (const [key, value] of Object.entries(facts)) { const node = q<HTMLElement>('[data-ch-fact="' + key + '"]'); if (node) node.textContent = value }
      drift.replaceChildren(); tests.replaceChildren(); select.replaceChildren()
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = t('Choose an observed file'); select.append(placeholder)
      for (const target of view?.targets ?? []) { const tr = document.createElement('tr'); cell(tr, target.path, true); cell(tr, target.reason === 'missing' ? t('Missing') : target.reason === 'content_mismatch' ? t('Content differs') : t('Metadata differs')); cell(tr, target.expectedChecksum, true); cell(tr, target.observedChecksum ?? t('Missing'), target.observedChecksum !== null); drift.append(tr); const option = document.createElement('option'); option.value = target.token; option.textContent = target.path; select.append(option) }
      for (const test of view?.tests ?? []) { const tr = document.createElement('tr'); cell(tr, test.name, true); cell(tr, test.state === 'passed' ? t(msgctxt('whm-configuration-health-client', 'Passed')) : test.state === 'failed' ? t(msgctxt('whm-configuration-health-client', 'Failed')) : t('Unavailable')); cell(tr, test.exitCode === null ? t('Not observed') : String(test.exitCode), test.exitCode !== null); tests.append(tr) }
      for (const [body, count, text] of [[drift, 4, view?.drift === 'clean' ? t('Managed file content matches the active manifest.') : t('No verified drift observation is available.')], [tests, 3, t('No current configuration tests are available.')]] as const) if (!body.children.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = count; td.textContent = text; tr.append(td); body.append(tr) }
      reason.textContent = view?.repairReason === 'ready' ? t('Repair restores one observed managed file. Other drift and pending changes are excluded.') : view?.repairReason === 'pending_changes' ? t('Saved changes are pending. Review configuration generations before repairing drift.') : view?.repairReason === 'no_drift' ? t('No observed file needs repair.') : t('Targeted recoverable repair is unavailable until the server supplies a qualified provider.')
      controls()
    }
    const load = async () => {
      if (busy || !admitted()) return
      busy = true; controls(); note('reading', t('Checking managed configuration and running reviewed tests…'))
      try { const next = parseView(await request!('GET', '/api/server/configuration-health')); if (!admitted()) { view = null; return }; view = next; review = false; confirmation.value = ''; feedback.hidden = true; note(next.state, next.state === 'read' ? t('Current configuration checks completed. Review each result below.') : t('Configuration state could not be verified.')) }
      catch { view = null; note('failed', t('Configuration checks could not be read. Refresh before continuing.')) }
      finally { busy = false; paint() }
    }
    repair.addEventListener('click', () => { void (async () => {
      if (busy || review || !admitted() || root.dataset.chCanRepair !== 'true' || !view?.canRepair || !view.generation || !view.revision || typeof askDialog !== 'function' || confirmation.value !== 'REPAIR CONFIGURATION') return
      const snapshot = view, target = view.targets.find(item => item.token === select.value)
      if (!target) return
      busy = true; controls()
      try {
        const approved = await askDialog({ title: t('Repair managed configuration'), body: target.path + '\n' + t('Restore only this file from the reviewed active generation with a recoverable preimage, then verify its checksum and configuration tests.'), confirm: t('Repair selected file'), danger: true })
        if (approved !== true || !admitted() || root.dataset.chCanRepair !== 'true' || snapshot !== view || confirmation.value !== 'REPAIR CONFIGURATION' || select.value !== target.token) return
        const next = parseRepair(await request!('POST', '/api/server/configuration-health/repair', { target: target.token, expectedRevision: snapshot.revision, expectedGenerationId: snapshot.generation!.id, expectedGenerationChecksum: snapshot.generation!.checksum, confirmation: 'REPAIR CONFIGURATION' }), target.token, snapshot.generation!)
        if (next.desired?.revision !== snapshot.desired?.revision || next.desired?.checksum !== snapshot.desired?.checksum || next.targets.some(item => item.path === target.path) || JSON.stringify(next.targets) !== JSON.stringify(snapshot.targets.filter(item => item.path !== target.path))) throw new Error('unverified_targeted_repair')
        view = next; review = true; feedback.dataset.state = 'verified'; feedback.textContent = t('The selected file repair and recovery backup were verified. Read configuration again before another action.'); feedback.hidden = false; confirmation.value = ''; paint()
      } catch (error) { const raw = error && typeof error === 'object' ? error as { detail?: Record<string, unknown>; details?: Record<string, unknown> } : null; const detail = raw?.details ?? raw?.detail; const refused = detail?.stateChanged === false && detail?.unknownOutcome !== true && detail?.verificationRequired !== true; review = true; feedback.dataset.state = refused ? 'refused' : 'unknown'; feedback.textContent = refused ? t('Repair was refused. Read current configuration before trying again.') : t('Repair outcome is unknown. Check recovery and current configuration before retrying.'); feedback.hidden = false }
      finally { busy = false; controls() }
    })() })
    refresh.addEventListener('click', () => { void load() }); select.addEventListener('change', controls); confirmation.addEventListener('input', controls)
    if (!admitted()) { controls(); note('unavailable', t('Configuration health is unavailable here. Nothing was read or changed.')); return }
    void load()
  })
}
export const WHM_CONFIGURATION_HEALTH_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readConfigurationHealthView=${readConfigurationHealthView.toString()};const readConfigurationHealthRepair=${readConfigurationHealthRepair.toString()};const bind=${bindWhmConfigurationHealth.toString()};return (askDialog)=>bind(askDialog,readConfigurationHealthView,readConfigurationHealthRepair);})()`
