/// <reference lib="dom" />
import { defaultPlan, PLAN_CAP_RULES, RESOURCE_RULES, type FeatureList, type Limit, type Plan } from '@xpanel/core'
import { formatDisplayName } from './display-name.ts'
import { escapeHtml } from './tokens.ts'
import { translator, type MessageValues, type Locale } from './i18n.ts'
type Copy = string
type Field = { key: string; id: string; label: Copy; min: number; max: number; scale: number }
const PLAN_NAME_PATTERN = String.raw`[A-Za-z0-9](?:[A-Za-z0-9 _.\-]{0,62}[A-Za-z0-9_.\-])?`

const resourceLabels: Record<keyof Plan['resources'], Copy> = {
  diskMb: msgid('Disk (MiB)'), bandwidthMbMonth: msgid('Monthly bandwidth (MiB)'),
  ioReadBps: msgid('Disk read (MiB/s)'), ioWriteBps: msgid('Disk write (MiB/s)'),
  ioReadIops: msgid('Read operations per second'), ioWriteIops: msgid('Write operations per second'),
  memoryMb: msgid('Memory (MiB)'), maxProcesses: msgid('Processes'), cpuPercent: msgid('CPU (%)'),
}
const capLabels: Record<keyof Plan['caps'], Copy> = {
  addonDomains: msgid('Addon domains'), aliasDomains: msgid('Alias domains'),
  subdomains: msgid('Subdomains'), mailboxes: msgid('Mailboxes'), forwarders: msgid('Forwarders'),
  mailingLists: msgid('Mailing lists'), ftpAccounts: msgid('FTP accounts'), databases: msgid('Databases'),
  phpWorkers: msgid('PHP workers'),
}
const ids: Record<string, string> = { cpuPercent: 'plan-cpu-quota', memoryMb: 'plan-memory-max', maxProcesses: 'plan-tasks-max' }
export const PLAN_RESOURCE_FIELDS: readonly Field[] = Object.entries(RESOURCE_RULES).map(([key, rule]) => ({
  key, id: ids[key] ?? `plan-${key}`, label: resourceLabels[key as keyof Plan['resources']], min: rule.min, max: rule.max,
  scale: key === 'ioReadBps' || key === 'ioWriteBps' ? 1024 * 1024 : 1,
}))
export const PLAN_CAP_FIELDS: readonly Field[] = Object.entries(PLAN_CAP_RULES).map(([key, rule]) => ({
  key, id: `plan-${key}`, label: capLabels[key as keyof Plan['caps']], min: rule.min, max: rule.max, scale: 1,
}))
const quotaRule = RESOURCE_RULES.diskMb
export const PLAN_QUOTA_FIELD: Field = { key: 'defaultMailboxQuotaMb', id: 'plan-mailbox-quota', label: msgid('Default mailbox quota (MiB)'), min: quotaRule.min, max: quotaRule.max, scale: 1 }

export type PlanEditorValues = Record<string, string | boolean>
export type PlanEditorPayload = Omit<Plan, 'id'>

export function planEditorRequest(payload: PlanEditorPayload, id?: string): { method: 'POST' | 'PATCH'; path: string; body: PlanEditorPayload | Omit<PlanEditorPayload, 'ownerId'> } {
  if (!id) return { method: 'POST', path: '/api/plans', body: payload }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('id')
  const { ownerId: _owner, ...patch } = payload
  return { method: 'PATCH', path: '/api/plans/' + id, body: patch }
}

/** Form parsing is structural only. The server still checks permissions and stored state. */
export function planEditorPayload(values: PlanEditorValues, ownerId: string | null): PlanEditorPayload {
  const limit = (field: Field): Limit => {
    if (values[`unlimited.${field.key}`] === true) return 'unlimited'
    const raw = values[field.key]
    if (typeof raw !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw.trim())) throw new Error(field.key)
    const amount = Number(raw.trim()) * field.scale
    if (!Number.isSafeInteger(amount) || amount < field.min || amount > field.max) throw new Error(field.key)
    return amount
  }
  const name = typeof values.name === 'string' ? values.name.trim() : ''
  if (!new RegExp(`^(?:${PLAN_NAME_PATTERN})$`).test(name)) throw new Error('name')
  const featureListId = typeof values.featureListId === 'string' ? values.featureListId : ''
  if (!featureListId) throw new Error('featureListId')
  const shell = values.shell
  if (shell !== 'none' && shell !== 'jailed') throw new Error('shell')
  const resources = Object.fromEntries(PLAN_RESOURCE_FIELDS.map(field => [field.key, limit(field)])) as unknown as Plan['resources']
  const caps = Object.fromEntries(PLAN_CAP_FIELDS.map(field => [field.key, limit(field)])) as unknown as Plan['caps']
  const defaultMailboxQuotaMb = limit(PLAN_QUOTA_FIELD)
  if (defaultMailboxQuotaMb !== 'unlimited' && resources.diskMb !== 'unlimited' && defaultMailboxQuotaMb > resources.diskMb) throw new Error('defaultMailboxQuotaMb')
  return { name, ownerId, featureListId, resources, caps, shell, dedicatedIp: values.dedicatedIp === true, defaultMailboxQuotaMb, enforceBandwidth: values.enforceBandwidth === true }
}

export function planEditorReceiptMatches(plan: Plan | undefined, payload: PlanEditorPayload, id?: string): plan is Plan {
  if (!plan || typeof plan.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(plan.id) || (id !== undefined && plan.id !== id)) return false
  return (['name', 'ownerId', 'featureListId', 'shell', 'dedicatedIp', 'defaultMailboxQuotaMb'] as const).every(key => plan[key] === payload[key]) && (plan.enforceBandwidth ?? false) === (payload.enforceBandwidth ?? false)
    && PLAN_RESOURCE_FIELDS.every(field => plan.resources?.[field.key as keyof Plan['resources']] === payload.resources[field.key as keyof Plan['resources']])
    && PLAN_CAP_FIELDS.every(field => plan.caps?.[field.key as keyof Plan['caps']] === payload.caps[field.key as keyof Plan['caps']])
}

export interface PlanEditorInput {
  locale?: Locale
  plan?: Plan
  featureLists: readonly Pick<FeatureList, 'id' | 'name'>[]
  ownerId: string | null
  canManage: boolean
  allowUnlimited: boolean
}

export function renderPlanEditor(input: PlanEditorInput): string {
  const text = (message: string, values?: MessageValues) => escapeHtml(translator(input.locale)(message, values))
  const seed = input.plan ?? defaultPlan({ featureListId: input.featureLists[0]?.id ?? '', ownerId: input.ownerId })
  const ownerId = input.plan ? input.plan.ownerId : input.ownerId
  const available = input.featureLists.some(list => list.id === seed.featureListId)
  const disabled = !input.canManage || !available
  const number = (field: Field, value: Limit): string => {
    const unlimited = value === 'unlimited'
    const fieldName = escapeHtml(field.key), id = escapeHtml(field.id)
    return `<div class="xp-field"><label class="xp-label" for="${id}">${escapeHtml(translator(input.locale)(field.label))}</label><input class="xp-input xp-mono" type="number" id="${id}" name="${fieldName}" dir="ltr" inputmode="decimal" min="${field.min / field.scale}" max="${field.max / field.scale}" step="${1 / field.scale}"${unlimited ? ' disabled' : ' required'} value="${unlimited ? '' : value / field.scale}" /><label class="xp-plan-cap-option" for="${id}-unlimited"><input id="${id}-unlimited" type="checkbox" name="unlimited.${fieldName}" data-plan-unlimited="${fieldName}"${unlimited ? ' checked' : ''}${input.allowUnlimited ? '' : ' disabled'} /><span>${text('Unlimited')}</span></label></div>`
  }
  // An in-card heading names the group; a native border legend would sit outside the card's 24px content edge.
  const heading = (id: string, title: string) => `<h3 id="${id}" class="xp-section-title" style="margin:0 0 calc(var(--xp-space-group,24px) - var(--xp-space-field,16px))">${escapeHtml(title)}</h3>`
  const group = (title: Copy, fields: readonly Field[], value: (key: string) => Limit) => {
    const id = `plan-group-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`
    return `<fieldset class="xp-card xp-form-group" aria-labelledby="${id}">${heading(id, translator(input.locale)(title))}${fields.map(field => number(field, value(field.key))).join('')}</fieldset>`
  }
  const planId = input.plan ? ` data-plan-id="${escapeHtml(input.plan.id)}"` : ''
  return `<form class="xp-form-group" action="/api/plans" method="post" data-native-plan-editor data-plan-owner="${escapeHtml(ownerId ?? '')}" data-plan-editable="${disabled ? 'false' : 'true'}"${planId}>
    <h2 class="xp-section-title">${(input.plan ? text('Edit plan') : text('Create plan'))}</h2>
    ${disabled ? `<p class="xp-help">${(!input.canManage ? text('This plan is read only.') : text('The feature list is unavailable. Saving is disabled.'))}</p>` : ''}
    <fieldset class="xp-form-group" style="gap:var(--xp-space-card)"${disabled ? ' disabled' : ''}>
      <div class="xp-form-group" style="min-inline-size:0">
      <div class="xp-field"><label class="xp-label" for="plan-name">${text('Plan Name')}</label><input id="plan-name" name="name" type="text" class="xp-input" required maxlength="64" pattern="${escapeHtml(PLAN_NAME_PATTERN)}" value="${input.plan ? escapeHtml(seed.name) : ''}" /></div>
      <div class="xp-field"><label class="xp-label" for="plan-feature-list">${text('Feature list')}</label><select id="plan-feature-list" name="featureListId" class="xp-select" required>${available ? '' : `<option value="" selected>${text('Unavailable')}</option>`}${input.featureLists.map(list => `<option value="${escapeHtml(list.id)}"${list.id === seed.featureListId ? ' selected' : ''}>${escapeHtml(formatDisplayName(list.name))}</option>`).join('')}</select></div>
      </div>
      ${group(msgid('Resources'), PLAN_RESOURCE_FIELDS, key => seed.resources[key as keyof Plan['resources']])}
      ${group(msgid('Service limits'), PLAN_CAP_FIELDS, key => seed.caps[key as keyof Plan['caps']])}
      <fieldset class="xp-card xp-form-group" aria-labelledby="plan-group-access">${heading('plan-group-access', translator(input.locale)('Access and mailbox defaults'))}
        <div class="xp-field"><label class="xp-label" for="plan-shell-toggle">${text('Jailed shell access')}</label><select id="plan-shell-toggle" name="shell" class="xp-select"><option value="none"${seed.shell === 'none' ? ' selected' : ''}>${text(msgctxt('plan-editor', 'Disabled'))}</option><option value="jailed"${seed.shell === 'jailed' ? ' selected' : ''}>${text('Jailed shell')}</option></select></div>
        <label class="xp-plan-cap-option" for="plan-dedicated-ip"><input id="plan-dedicated-ip" name="dedicatedIp" type="checkbox"${seed.dedicatedIp ? ' checked' : ''} /><span>${text('Dedicated IPv4 required')}</span></label>
        <label class="xp-plan-cap-option" for="plan-enforce-bandwidth"><input id="plan-enforce-bandwidth" name="enforceBandwidth" type="checkbox"${seed.enforceBandwidth ? ' checked' : ''} /><span>${text('Serve the bandwidth-exceeded page once the monthly bandwidth is used')}</span></label>
        ${number(PLAN_QUOTA_FIELD, seed.defaultMailboxQuotaMb)}
      </fieldset>
    </fieldset>
    <p class="xp-help" data-native-plan-status role="status" aria-live="polite" tabindex="-1" hidden></p>
    <button type="submit" class="xp-btn xp-btn--primary" data-native-plan-save disabled>${text('Save plan')}</button>
  </form>`
}

function bindPlanEditorForms(): void {
  document.querySelectorAll<HTMLFormElement>('[data-native-plan-editor]').forEach(form => {
    const save = form.querySelector<HTMLButtonElement>('[data-native-plan-save]')
    const status = form.querySelector<HTMLElement>('[data-native-plan-status]')
    if (!save || !status) return
    const copy = (message: string, values?: MessageValues) => xpT(message, values)
    const editable = form.dataset.planEditable === 'true'
    let busy = false, reviewRequired = false
    const owner = form.dataset.planOwner || null
    const values = (): PlanEditorValues => Object.fromEntries(Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name],select[name]')).map(control => [control.name, control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value]))
    const signature = (): string => { try { return JSON.stringify(planEditorPayload(values(), owner)) } catch { return JSON.stringify(values()) } }
    let baseline = signature()
    const note = (message: string, state: string) => { status.textContent = message; status.hidden = false; status.dataset.state = state; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    let draftReview: { refresh(): void; beforeSubmit(): boolean; accepted(payload: PlanEditorPayload): void } | undefined
    const refresh = () => {
      form.querySelectorAll<HTMLInputElement>('[data-plan-unlimited]').forEach(toggle => {
        const control = form.elements.namedItem(toggle.dataset.planUnlimited || '')
        if (control instanceof HTMLInputElement) { control.disabled = toggle.checked || !editable; control.required = !toggle.checked }
      })
      save.disabled = !editable || busy || reviewRequired || signature() === baseline
      draftReview?.refresh()
    }
    const review = form.querySelector<HTMLElement>('[data-native-plan-review]')
    if (review) {
      const editor = form.querySelector<HTMLElement>('[data-plan-review-editor]')
      const open = form.querySelector<HTMLButtonElement>('[data-plan-review-open]'), back = form.querySelector<HTMLButtonElement>('[data-plan-review-back]')
      const openWrap = form.querySelector<HTMLElement>('[data-plan-review-open-wrap]'), backWrap = form.querySelector<HTMLElement>('[data-plan-review-back-wrap]'), saveWrap = form.querySelector<HTMLElement>('[data-plan-review-save-wrap]')
      const reviewStatus = review.querySelector<HTMLElement>('[data-plan-review-status]'), count = review.querySelector<HTMLElement>('[data-plan-review-count]'), empty = review.querySelector<HTMLElement>('[data-plan-review-empty]'), summary = form.querySelector<HTMLElement>('[data-plan-review-summary]')
      const keys = ['name', 'featureListId', ...PLAN_RESOURCE_FIELDS.map(field => field.key), ...PLAN_CAP_FIELDS.map(field => field.key), 'shell', 'dedicatedIp', 'enforceBandwidth', 'defaultMailboxQuotaMb']
      let reviewing = false, reviewedSignature = '', current: PlanEditorPayload | undefined
      const readable = review.dataset.planReviewReadable === 'true'
      if (readable && review.dataset.planReviewSaved === 'true') { try { current = planEditorPayload(values(), owner) } catch { /* Invalid saved fields are not promoted to a verified comparison. */ } }
      const validMarkup = (): boolean => {
        if (!review.isConnected || !editor?.isConnected || !open || !back || !openWrap || !backWrap || !saveWrap || !reviewStatus || !count || !empty || !summary || open.type !== 'button' || back.type !== 'button') return false
        if ([editor, open, back, openWrap, backWrap, saveWrap, reviewStatus, count, empty, summary].some(node => !node || !node.isConnected || !form.contains(node)) || !saveWrap.contains(save) || !review.contains(reviewStatus) || !review.contains(count) || !review.contains(empty)) return false
        const rows = [...review.querySelectorAll<HTMLElement>('[data-plan-review-key]')]
        return rows.length === keys.length && keys.every(key => {
          const matches = rows.filter(row => row.dataset.planReviewKey === key)
          return matches.length === 1 && matches[0]!.tagName === 'LI' && ['from', 'to'].every(slot => { const cells = matches[0]!.querySelectorAll('[data-plan-review-' + slot + ']'); return cells.length === 1 && cells[0]!.tagName === 'BDI' })
        })
      }
      const flat = (payload: PlanEditorPayload): Record<string, string | number | boolean> => ({ name: payload.name, featureListId: payload.featureListId, ...payload.resources, ...payload.caps, shell: payload.shell, dedicatedIp: payload.dedicatedIp, enforceBandwidth: payload.enforceBandwidth ?? false, defaultMailboxQuotaMb: payload.defaultMailboxQuotaMb })
      const display = (key: string, value: string | number | boolean): string => {
        if (typeof value === 'boolean') return copy(value ? 'Yes' : 'No')
        if (typeof value === 'number') return String(value / ([...PLAN_RESOURCE_FIELDS, ...PLAN_CAP_FIELDS, PLAN_QUOTA_FIELD].find(field => field.key === key)?.scale ?? 1))
        if (value === 'unlimited') return copy('Unlimited')
        if (key === 'featureListId' || key === 'shell') { const select = form.elements.namedItem(key); return select instanceof HTMLSelectElement ? [...select.options].find(option => option.value === value)?.textContent ?? copy('Unavailable') : copy('Unavailable') }
        return value
      }
      const showEditor = (control?: Element | null): void => {
        reviewing = false; reviewedSignature = ''
        if (editor) editor.hidden = false
        review.hidden = true
        const panel = control?.closest<HTMLElement>('[role="tabpanel"]')
        if (panel) form.querySelectorAll<HTMLButtonElement>('[data-presentation-tab]').forEach(tab => { if (tab.getAttribute('aria-controls') === panel.id) tab.click() })
      }
      const project = (): boolean => {
        const valid = validMarkup()
        if (!valid) { reviewing = false; reviewedSignature = ''; save.disabled = true; if (open) open.disabled = true; if (reviewStatus) reviewStatus.textContent = copy('Unavailable'); if (summary) summary.textContent = copy('Unavailable'); if (openWrap) openWrap.hidden = false; if (backWrap) backWrap.hidden = true; if (saveWrap) saveWrap.hidden = true; review.dataset.state = 'unavailable'; if (editor) editor.hidden = false; review.hidden = true; return false }
        const now = signature(), dirty = now !== baseline
        if (reviewing && now !== reviewedSignature) showEditor()
        let proposed: PlanEditorPayload | undefined
        if (readable) { try { proposed = planEditorPayload(values(), owner) } catch { /* The canonical parser owns validity. */ } }
        const from = current && flat(current), to = proposed && flat(proposed)
        let changes = 0
        for (const row of review.querySelectorAll<HTMLElement>('[data-plan-review-key]')) {
          const key = row.dataset.planReviewKey!, changed = !!to && (!from || from[key] !== to[key])
          row.hidden = !changed
          for (const [slot, source] of [['from', from], ['to', to]] as const) {
            const cell = row.querySelector<HTMLElement>('[data-plan-review-' + slot + ']')!
            const value = source?.[key]
            cell.textContent = value === undefined ? copy(readable ? proposed ? 'Not read' : 'Unavailable' : 'Not read') : display(key, value)
            cell.dir = typeof value === 'number' ? 'ltr' : 'auto'
          }
          if (changed) changes++
        }
        const state = !readable ? 'unread' : !proposed ? 'invalid' : reviewRequired ? 'unverified' : busy ? 'loading' : dirty ? 'draft' : current ? 'saved' : 'draft'
        review.dataset.state = state; review.dataset.dirty = String(dirty)
        count!.textContent = String(changes); empty!.hidden = changes !== 0
        const message = state === 'unread' ? copy('Not read') : state === 'invalid' ? copy('Check the plan values. No changes were sent.') : state === 'unverified' ? copy('The result could not be verified. Review plans before retrying.') : state === 'loading' ? copy('Saving…') : dirty ? copy('Unsaved changes') : current ? copy('Saved') : copy('Draft')
        reviewStatus!.textContent = message; empty!.textContent = message; summary!.textContent = message
        editor!.hidden = reviewing; review.hidden = !reviewing
        openWrap!.hidden = reviewing; backWrap!.hidden = !reviewing; saveWrap!.hidden = !reviewing
        open!.disabled = !editable || busy || reviewRequired || !dirty || !proposed || !readable
        back!.disabled = busy
        save.disabled = !editable || busy || reviewRequired || !dirty || !reviewing || reviewedSignature !== now || !proposed || !readable
        return !!proposed && readable
      }
      open?.addEventListener('click', () => {
        if (!editable || busy || reviewRequired || signature() === baseline || !project()) return
        if (!form.reportValidity()) return
        reviewing = true; reviewedSignature = signature(); project(); back?.focus()
      })
      back?.addEventListener('click', () => { if (busy) return; showEditor(); project(); open?.focus() })
      form.addEventListener('invalid', event => { const control = event.target; if (control instanceof HTMLElement) showEditor(control) }, true)
      draftReview = {
        refresh: () => { project() },
        beforeSubmit: () => {
          const valid = project()
          if (!valid || !reviewing || reviewedSignature !== signature()) { showEditor(); project(); note(copy('Check the plan values. No changes were sent.'), 'failed'); return false }
          return true
        },
        accepted: payload => { current = JSON.parse(JSON.stringify(payload)) as PlanEditorPayload; showEditor() },
      }
    }
    form.addEventListener('input', refresh)
    form.addEventListener('change', refresh)
    window.addEventListener('beforeunload', event => {
      if (signature() === baseline && !reviewRequired) return
      event.preventDefault(); event.returnValue = ''
    })
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (draftReview && !draftReview.beforeSubmit()) return
      if (!editable || busy || reviewRequired || signature() === baseline || !form.reportValidity()) return
      let payload: PlanEditorPayload
      try { payload = planEditorPayload(values(), owner) } catch (error) {
        const field = error instanceof Error ? error.message : ''
        const control = form.elements.namedItem(field)
        note(copy('Check the plan values. No changes were sent.'), 'failed')
        if (control instanceof HTMLElement) control.focus()
        return
      }
      const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body: unknown) => Promise<unknown> }).xpanelSessionRequest
      if (typeof request !== 'function') { note(copy('Saving is unavailable. No changes were sent.'), 'failed'); return }
      const id = form.dataset.planId
      if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) { note(copy('The saved plan could not be identified.'), 'failed'); return }
      const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')).map(control => ({ control, disabled: control.disabled }))
      busy = true; form.setAttribute('aria-busy', 'true'); controls.forEach(({ control }) => { control.disabled = true })
      note(copy('Saving…'), 'loading')
      draftReview?.refresh()
      const operation = planEditorRequest(payload, id)
      Promise.resolve().then(() => request(operation.method, operation.path, operation.body)).then(result => {
        const receipt = result as { plan?: Plan; reconcile?: { status?: string } } | null
        const persisted = receipt?.plan
        if (!planEditorReceiptMatches(persisted, payload, id)) { reviewRequired = true; note(copy('The result could not be verified. Review plans before retrying.'), 'failed'); return }
        form.dataset.planId = persisted.id; baseline = JSON.stringify(payload)
        draftReview?.accepted(payload)
        note((id ? copy('Plan saved. Hosting verification is not confirmed.') : copy('Plan saved as desired configuration.')), id ? 'pending' : 'saved')
      }).catch((error: { status?: number; details?: { stateChanged?: boolean; verificationRequired?: boolean } }) => {
        reviewRequired = error?.details?.stateChanged === true || error?.details?.verificationRequired === true || ![400, 401, 403, 404, 409, 412, 422].includes(error?.status ?? 0)
        note(reviewRequired ? copy('The result is uncertain. Review plans before retrying.') : copy('The plan was refused. Review its values and permissions.'), 'failed')
      }).finally(() => {
        busy = false; form.removeAttribute('aria-busy'); controls.forEach(({ control, disabled }) => { control.disabled = disabled }); refresh()
      })
    })
    refresh()
  })
}

export const PLAN_EDITOR_CLIENT_SCRIPT = `(() => { const PLAN_NAME_PATTERN = ${JSON.stringify(PLAN_NAME_PATTERN)}; const PLAN_RESOURCE_FIELDS = ${JSON.stringify(PLAN_RESOURCE_FIELDS)}; const PLAN_CAP_FIELDS = ${JSON.stringify(PLAN_CAP_FIELDS)}; const PLAN_QUOTA_FIELD = ${JSON.stringify(PLAN_QUOTA_FIELD)}; ${planEditorPayload.toString()}; ${planEditorRequest.toString()}; ${planEditorReceiptMatches.toString()}; (${bindPlanEditorForms.toString()})(); })();`
