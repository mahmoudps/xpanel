import { WHM_CLIENT_TEMPLATE_BINDING, whmClientNode as canonicalWhmClientNode, clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './whm-client-templates.ts'
const whmClientNode = canonicalWhmClientNode, clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot, cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { buildWhmWebRollbackRequest, readWhmWebGeneration, readWhmWebGenerations, readWhmWebRollbackAck, whmWebObject, type WhmWebGenerationRead } from './whm-web-server-client.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
// Local aliases: the bind function is serialized, so it must not reference module imports directly.
const panelObject = whmWebObject, panelGenerations = readWhmWebGenerations, panelRollbackRequest = buildWhmWebRollbackRequest, panelRollbackAck = readWhmWebRollbackAck

/** /whm/panel/data: generation history and guarded rollback through GET /api/generations and POST /api/generations/:id/rollback. */
function bindWhmPanelData(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-generations]').forEach(root => {
    if (root.dataset.generationsBound === 'true') return
    root.dataset.generationsBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-generations-status]'), body = root.querySelector<HTMLTableSectionElement>('tbody[data-generation-rows]')
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !body) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.generationsEditable === 'true' && !root.closest(denied) && typeof request === 'function'
    let busy = false, review = false, read: WhmWebGenerationRead | null = null
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const restorable = (): boolean => !!read && read.canRollback && !!read.currentGeneration && read.desiredState?.pending === false
    const sync = (): void => {
      const open = !busy && !review && admitted() && restorable()
      body.querySelectorAll<HTMLButtonElement>('[data-action="rollback-generation"]').forEach(button => { button.disabled = !open || !read!.rollbackEligibleGenerationIds.includes(Number(button.dataset.generationId)) })
      root.setAttribute('aria-busy', String(busy))
    }
    const explain = (): void => note('read', restorable() ? t('Restore requires fresh current/target checks, the current desired-state revision and typing the persisted target generation number. Saved pending changes prevent restoration.')
      : read?.desiredState?.pending ? t('Saved desired changes differ from the active snapshot. Restoration is blocked to preserve them.') : t('Guarded restore admission or authoritative desired-state metadata is unavailable. History remains readable.'))
    const paint = (value: WhmWebGenerationRead): void => {
      read = value
      body.textContent = ''
      for (const generation of value.generations) {
        const row = cloneClientTemplate(clientTemplate(root, 'whm-generation-row'), 'tr', ['generation', 'created', 'summary', 'state', 'actions'])
        row.dataset.generationRow = String(generation.id)
        const technical = (text: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = text; return bdi }
        clientTemplateSlot(row, 'generation').replaceChildren(technical('#' + String(generation.id)))
        const created = document.createElement('span'); created.append(t('Created') + ' ', technical(formatDisplayDateTime(generation.createdAt)))
        clientTemplateSlot(row, 'created').replaceChildren(created)
        const summary = document.createElement('span'); summary.append(technical('sha256:' + generation.checksum))
        if (generation.filesCount !== undefined) summary.append(' · ' + t('{count, plural, one {{count} file} other {{count} files}}', { count: generation.filesCount }))
        clientTemplateSlot(row, 'summary').replaceChildren(summary)
        const badge = whmClientNode(root, generation.status === 'active' ? 'whm-generation-state-active' : 'whm-generation-state-other', 'span', generation.status)
        badge.dataset.status = generation.status
        clientTemplateSlot(row, 'state').replaceChildren(badge)
        const button = whmClientNode(root, 'whm-generation-rollback', 'button', t('Rollback to #{generationId}', { generationId: generation.id }))
        button.dataset.action = 'rollback-generation'; button.dataset.generationId = String(generation.id); button.disabled = true
        clientTemplateSlot(row, 'actions').replaceChildren(button)
        body.append(row)
      }
      if (!value.generations.length) body.append(whmClientNode(root, 'whm-generation-empty', 'tr', t('The generation read returned no records.')))
      const current = root.querySelector('[data-generations-current]')
      if (current) {
        const state = value.currentGeneration ? 'active' : 'none'
        const badge = whmClientNode(root, 'whm-generation-current-' + state, 'span', value.currentGeneration ? t('Generation {generationId}', { generationId: value.currentGeneration.id }) : t('No configuration generation is active'))
        badge.dataset.state = state; current.replaceChildren(badge)
      }
    }
    const rollback = async (id: number): Promise<void> => {
      if (busy || review || !admitted() || !restorable()) return
      const snapshot = read!, target = snapshot.generations.find(item => item.id === id), current = snapshot.currentGeneration!, desiredState = snapshot.desiredState!
      if (!target || !snapshot.rollbackEligibleGenerationIds.includes(id)) return
      if (typeof askDialog !== 'function') { note('failed', t('A verified target, desired state and confirmation are required; nothing was sent.')); return }
      busy = true; sync(); let wrote = false
      try {
        const confirmation = await askDialog({ title: t('Restore a server generation'), body: t('This restores a server-wide desired-state snapshot and reconciles it. Review all affected accounts. Type the persisted target generation number: {id}', { id }), input: true, label: t('Target generation number'), confirm: t('Restore generation'), danger: true })
        if (confirmation === null || confirmation === false || confirmation === undefined) return
        const payload = panelRollbackRequest(current, target, desiredState, confirmation)
        if (!admitted()) throw { status: 403, details: { stateChanged: false } }
        const fresh = panelGenerations(await request!('GET', '/api/generations')), freshTarget = fresh.generations.find(item => item.id === id)
        if (!fresh.canRollback || !fresh.rollbackEligibleGenerationIds.includes(id) || !fresh.desiredState || fresh.desiredState.pending || fresh.desiredState.revision !== desiredState.revision || fresh.desiredState.checksum !== desiredState.checksum
          || fresh.currentGeneration?.id !== current.id || fresh.currentGeneration.checksum !== current.checksum || !freshTarget || freshTarget.checksum !== target.checksum || freshTarget.status !== 'superseded') {
          review = true; paint(fresh); note('stale', t('Current state, admission or the target changed. Saved changes are preserved; read and review before restoring.')); return
        }
        wrote = true
        const acknowledged = panelRollbackAck(await request!('POST', '/api/generations/' + String(id) + '/rollback', payload), target)
        const observed = panelGenerations(await request!('GET', '/api/generations'))
        if (observed.currentGeneration?.id !== acknowledged.id || observed.currentGeneration.checksum !== acknowledged.checksum || !observed.desiredState || observed.desiredState.pending || observed.desiredState.revision < desiredState.revision) throw new Error('rollback_readback_mismatch')
        paint(observed)
        note('restored', t('The requested snapshot restore was acknowledged and its resulting active generation was read back. Application health is not verified here.'))
      } catch (error) {
        const value = panelObject(error) ? error : {}, details = panelObject(value.details) ? value.details : {}
        const uncertain = wrote && ([value, details].some(part => part.unknownOutcome === true || part.verificationRequired === true || part.needsAttention === true || part.stateChanged === true) || !(details.stateChanged === false || typeof value.status === 'number' && value.status >= 400 && value.status < 500 && value.status !== 408))
        review = uncertain || value.status === 409
        note(review ? 'uncertain' : 'failed', review ? t('The restore outcome requires review. No retry was sent; read current state before continuing.') : t('Restore was refused or confirmation did not match. No automatic retry was sent.'))
      } finally { busy = false; sync() }
    }
    body.addEventListener('click', event => { const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-action="rollback-generation"]') : null; if (button && !button.disabled) void rollback(Number(button.dataset.generationId)) })
    if (!admitted()) { sync(); note('unavailable', t('Generation history and rollback require root authorization. Nothing was read or changed.')); return }
    busy = true; sync(); note('reading', t('Reading…'))
    void request!('GET', '/api/generations').then(panelGenerations).then(value => { paint(value); busy = false; sync(); explain() }, () => { busy = false; sync(); note('failed', t('Generation history could not be read. Rollback stays unavailable.')) })
  })
}

export const WHM_PANEL_DATA_CLIENT_BINDING = `(()=>{${WHM_CLIENT_TEMPLATE_BINDING}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const whmWebObject=${whmWebObject.toString()};const readWhmWebGeneration=${readWhmWebGeneration.toString()};const readWhmWebGenerations=${readWhmWebGenerations.toString()};const buildWhmWebRollbackRequest=${buildWhmWebRollbackRequest.toString()};const readWhmWebRollbackAck=${readWhmWebRollbackAck.toString()};const panelObject=whmWebObject,panelGenerations=readWhmWebGenerations,panelRollbackRequest=buildWhmWebRollbackRequest,panelRollbackAck=readWhmWebRollbackAck;return ${bindWhmPanelData.toString()};})()`
