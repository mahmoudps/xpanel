/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
import { readComposerJobReview, readComposerWorkspaceView } from '../../../packages/os/src/composer-command-view.ts'
import type { ComposerJobReviewView, ComposerWorkspaceView } from '../../../packages/os/src/composer-command-view.ts'
export { readComposerJobReview, readComposerWorkspaceView }

type Ask = (options: Record<string, unknown>) => Promise<unknown>
function bindWhmComposer(askDialog: Ask | undefined, parse: typeof readComposerWorkspaceView, parseReview: typeof readComposerJobReview): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-composer]').forEach(root => {
    if (root.dataset.composerBound === 'true') return
    root.dataset.composerBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-composer-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-composer-refresh]'), target = root.querySelector<HTMLSelectElement>('[data-composer-target]'), body = root.querySelector<HTMLElement>('[data-composer-packages]')
    if (!status || !refresh || !target || !body) return
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const runAction = root.querySelector<HTMLSelectElement>('[data-composer-run-action]'), reviewButton = root.querySelector<HTMLButtonElement>('[data-composer-review]'), runButton = root.querySelector<HTMLButtonElement>('[data-composer-run]')
    const reviewRegion = root.querySelector<HTMLElement>('[data-composer-review-region]'), reviewBody = root.querySelector<HTMLElement>('[data-composer-review-packages]'), runHelp = root.querySelector<HTMLElement>('[data-composer-run-help]'), jobLink = root.querySelector<HTMLAnchorElement>('[data-composer-job-link]'), liveLog = root.querySelector<HTMLElement>('[data-composer-live-log]')
    const blocked = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.composerCanRead === 'true' && !root.closest(blocked)
    let busy = false, projects: ComposerWorkspaceView['projects'] = [], current: ComposerWorkspaceView | null = null, review: ComposerJobReviewView | null = null, locked = false
    // Job controls follow the agent's qualified-provider state; an unknown submission locks them until the next read.
    const runnable = (): boolean => admitted() && !busy && !locked && current?.actions.install === true && current.selected?.state === 'read' && typeof askDialog === 'function'
    const clearReview = (): void => { review = null; if (reviewRegion) reviewRegion.hidden = true; if (reviewBody) reviewBody.textContent = '' }
    const lockJobs = (): void => { if (runAction) runAction.disabled = !runnable(); if (reviewButton) reviewButton.disabled = !runnable(); if (runButton) runButton.disabled = !runnable() || !review || review.action !== runAction?.value }
    // Human status text in a value slot leaves the technical mono font.
    const text = (key: string, value: string, human = false): void => { const node = root.querySelector<HTMLElement>('[data-composer-' + key + ']'); if (!node) return; node.textContent = value; node.toggleAttribute('data-human', human) }
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const empty = (message: string): void => { body.textContent = ''; const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = message; row.append(cell); body.append(row) }
    const clear = (): void => { for (const key of ['account', 'directory', 'php', 'manifest', 'lock', 'vendor', 'match']) text(key, t('Not read'), true); empty(t('No selected project has been read.')) }
    const paint = (value: ComposerWorkspaceView): void => {
      current = value; locked = false; clearReview()
      if (runHelp) runHelp.textContent = value.actions.install ? t('Review the dependency graph that the confined provider resolves, then submit it as a host job. Project scripts and plugins never run.') : t('Install, update and custom mirrors require a reviewed account-isolated Composer job runner with script/plugin restrictions, resource limits and verified ownership. That provider is unavailable; no job can be submitted here.')
      projects = value.projects; target.textContent = ''
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = projects.length ? t(msgctxt('whm-composer-client', 'Choose a site')) : t('No active PHP sites'); target.append(placeholder)
      for (const item of projects) { const option = document.createElement('option'); option.value = item.selector; option.textContent = item.domain + ' — ' + item.account; target.append(option) }
      target.value = value.selected?.selector ?? ''; text('version', value.binary.version ?? t('Unavailable'), !value.binary.version); text('observed', formatDisplayDateTime(value.observedAt)); clear()
      const selected = value.selected, project = projects.find(item => item.selector === selected?.selector)
      if (!selected || !project) { note('read', t('Composer inventory read. Choose a saved site to inspect its dependencies.')); return }
      text('account', project.account); text('directory', project.directory); text('php', project.phpVersion)
      const label = (state: string): string => state === 'present' ? t('Present') : state === 'missing' ? t('Missing') : t('Unavailable')
      text('manifest', label(selected.manifest)); text('lock', label(selected.lock)); text('vendor', label(selected.vendor)); text('match', selected.lockMatch === 'matches' ? t('Metadata versions match') : selected.lockMatch === 'differs' ? t('Metadata versions differ') : t(msgctxt('whm-composer-client', 'Not verified')))
      if (selected.state !== 'read') {
        empty(t('Dependency data is unavailable.'))
        note('unavailable', selected.reason === 'composer-json-missing' ? t('COMPOSER_JSON_MISSING: this site has no composer.json. No command was run in the project.') : selected.reason === 'invalid-project-data' ? t('Project metadata is malformed, changing or exceeds the supported limits. No packages are assumed installed.') : t('The confined project file provider could not read this site. No project command was run.')); return
      }
      body.textContent = ''
      for (const item of selected.packages) {
        const row = document.createElement('tr')
        for (const [index, content] of [item.name, item.requirement ?? '—', item.locked ?? '—', item.installed ?? '—', item.development ? t('Yes') : t('No')].entries()) { const cell = document.createElement('td'), span = document.createElement(index < 4 ? 'bdi' : 'span'); if (index < 4) span.dir = 'ltr'; span.textContent = content; cell.append(span); row.append(cell) }
        body.append(row)
      }
      if (!selected.packages.length) empty(t('No package dependencies were declared or recorded.'))
      note('read', t('Bounded dependency metadata read. No project scripts, plugins or install/update jobs were executed.'))
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !request) return
      const selector = target.value
      if (selector && !projects.some(item => item.selector === selector)) return
      busy = true; current = null; clearReview(); lockJobs(); refresh.disabled = true; target.disabled = true; root.setAttribute('aria-busy', 'true'); clear(); note('reading', t('Reading Composer and project metadata…'))
      try {
        const view = parse(await request('GET', '/api/server/composer' + (selector ? '?domainId=' + encodeURIComponent(selector) : '')))
        if ((view.selected?.selector ?? '') !== selector) throw new Error('wrong_project')
        if (admitted()) paint(view)
      } catch { if (admitted()) { text('version', t('Unavailable'), true); text('observed', t('Not read'), true); clear(); note('failed', t('Composer state could not be verified. Read again; no change was made.')) } }
      finally { busy = false; refresh.disabled = !admitted(); target.disabled = !admitted() || projects.length === 0; root.setAttribute('aria-busy', 'false'); lockJobs() }
    }
    const code = (error: unknown): number => error && typeof error === 'object' ? Number((error as Record<string, any>).status) : NaN
    const reviewJob = async (): Promise<void> => {
      if (!runnable() || !runAction || !request || !current?.selected) return
      const domainId = current.selected.selector, action = runAction.value
      busy = true; clearReview(); lockJobs(); note('reading', t('Resolving the dependency graph with the confined provider…'))
      try {
        const next = parseReview(await request('POST', '/api/server/composer/jobs/preview', { action, domainId }))
        if (next.action !== action || next.domainId !== domainId || current?.selected?.selector !== domainId || !admitted()) throw new Error('wrong_review')
        review = next
        if (reviewBody) for (const item of next.packages) { const row = document.createElement('tr'); for (const [index, content] of [item.name, item.version, item.development ? t('Yes') : t('No')].entries()) { const cell = document.createElement('td'), span = document.createElement(index < 2 ? 'bdi' : 'span'); if (index < 2) span.dir = 'ltr'; span.textContent = content; cell.append(span); row.append(cell) } reviewBody.append(row) }
        if (reviewRegion) reviewRegion.hidden = false
        note('read', t('Review ready: {count, plural, one {# package} other {# packages}} in the resolved graph. Submit it to run the isolated job.', { count: next.packages.length }))
      } catch (error) { note('failed', code(error) === 412 ? t('The confined Composer provider is unavailable on this server. No job was submitted.') : code(error) === 409 ? t('The project changed. Read it again before reviewing.') : t('The review could not be verified. No job was submitted.')) }
      finally { busy = false; lockJobs() }
    }
    const runJob = async (): Promise<void> => {
      if (!runnable() || !review || !request) return
      const reviewed = review
      busy = true; lockJobs()
      let approved = false
      try { approved = await askDialog!({ title: t('Run Composer {action} for {domain}?', { action: reviewed.action, domain: reviewed.domain }), body: t('The isolated job installs exactly the reviewed graph without scripts, plugins or network access, and keeps a recovery snapshot.'), danger: true, confirm: t('Submit host job') }) === true } catch { approved = false }
      if (!approved || review !== reviewed || !admitted()) { busy = false; lockJobs(); return }
      note('reading', t('Submitting the host job…'))
      try {
        const result = await request('POST', '/api/server/composer/jobs/apply', { action: reviewed.action, domainId: reviewed.domainId, expectedRevision: reviewed.expectedRevision, reviewFingerprint: reviewed.reviewFingerprint }) as { job?: { id?: unknown; kind?: unknown } }
        if (!result || typeof result.job?.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.job.id) || result.job.kind !== 'composer.dependencies.' + reviewed.action) throw { details: {} }
        locked = true; clearReview()
        if (jobLink) jobLink.href = '/whm/jobs?job=' + encodeURIComponent(result.job.id)
        if (liveLog) liveLog.textContent = t('Job submitted. Its verified result and log appear on the host jobs page.')
        note('submitted', t('Host job submitted. Dependency metadata is unchanged here until you read the site again after the job finishes.'))
      } catch (error) {
        const detail = error && typeof error === 'object' ? (error as Record<string, any>).details ?? (error as Record<string, any>).detail : null
        if (detail && detail.stateChanged === false) note('failed', code(error) === 409 ? t('The project changed. Read it again before reviewing.') : t('The job was refused. Nothing was changed.'))
        else { locked = true; note('uncertain', t('The submission outcome is unknown. Check the host jobs page before trying again; job controls stay locked until you read the site again.')) }
      } finally { busy = false; lockJobs() }
    }
    runAction?.addEventListener('change', () => { clearReview(); lockJobs() })
    reviewButton?.addEventListener('click', () => { void reviewJob() })
    runButton?.addEventListener('click', () => { void runJob() })
    if (!request || !admitted()) { refresh.disabled = true; target.disabled = true; note('unavailable', t('Composer reads are unavailable here.')); return }
    refresh.addEventListener('click', () => { void load() }); target.addEventListener('change', () => { void load() }); void load()
  })
}
export const WHM_COMPOSER_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const parse=${readComposerWorkspaceView.toString()};const parseReview=${readComposerJobReview.toString()};const bind=${bindWhmComposer.toString()};return (ask)=>bind(ask,parse,parseReview);})()`
