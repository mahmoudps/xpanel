/// <reference lib="dom" />
import { defaultPlan, PLAN_CAP_RULES, RESOURCE_RULES, type FeatureList, type Limit, type Plan } from '@xpanel/core'
import { formatDisplayName } from './display-name.ts'
import { escapeHtml } from './tokens.ts'

type Copy = readonly [string, string]
type Field = { key: string; id: string; label: Copy; min: number; max: number; scale: number }
const PLAN_NAME_PATTERN = String.raw`[A-Za-z0-9](?:[A-Za-z0-9 _.\-]{0,62}[A-Za-z0-9_.\-])?`

const resourceLabels: Record<keyof Plan['resources'], Copy> = {
  diskMb: ['Disk (MiB)', 'القرص (MiB)'], bandwidthMbMonth: ['Monthly bandwidth (MiB)', 'نقل البيانات الشهري (MiB)'],
  ioReadBps: ['Disk read (MiB/s)', 'قراءة القرص (MiB/s)'], ioWriteBps: ['Disk write (MiB/s)', 'كتابة القرص (MiB/s)'],
  ioReadIops: ['Read operations per second', 'عمليات القراءة في الثانية'], ioWriteIops: ['Write operations per second', 'عمليات الكتابة في الثانية'],
  memoryMb: ['Memory (MiB)', 'الذاكرة (MiB)'], maxProcesses: ['Processes', 'العمليات'], cpuPercent: ['CPU (%)', 'المعالج (%)'],
}
const capLabels: Record<keyof Plan['caps'], Copy> = {
  addonDomains: ['Addon domains', 'النطاقات الإضافية'], aliasDomains: ['Alias domains', 'النطاقات البديلة'],
  subdomains: ['Subdomains', 'النطاقات الفرعية'], mailboxes: ['Mailboxes', 'صناديق البريد'], forwarders: ['Forwarders', 'إعادة التوجيه'],
  mailingLists: ['Mailing lists', 'القوائم البريدية'], ftpAccounts: ['FTP accounts', 'حسابات FTP'], databases: ['Databases', 'قواعد البيانات'],
  phpWorkers: ['PHP workers', 'عمليات PHP'],
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
export const PLAN_QUOTA_FIELD: Field = { key: 'defaultMailboxQuotaMb', id: 'plan-mailbox-quota', label: ['Default mailbox quota (MiB)', 'الحصة الافتراضية لصندوق البريد (MiB)'], min: quotaRule.min, max: quotaRule.max, scale: 1 }

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
  return { name, ownerId, featureListId, resources, caps, shell, dedicatedIp: values.dedicatedIp === true, defaultMailboxQuotaMb }
}

export function planEditorReceiptMatches(plan: Plan | undefined, payload: PlanEditorPayload, id?: string): plan is Plan {
  if (!plan || typeof plan.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(plan.id) || (id !== undefined && plan.id !== id)) return false
  return (['name', 'ownerId', 'featureListId', 'shell', 'dedicatedIp', 'defaultMailboxQuotaMb'] as const).every(key => plan[key] === payload[key])
    && PLAN_RESOURCE_FIELDS.every(field => plan.resources?.[field.key as keyof Plan['resources']] === payload.resources[field.key as keyof Plan['resources']])
    && PLAN_CAP_FIELDS.every(field => plan.caps?.[field.key as keyof Plan['caps']] === payload.caps[field.key as keyof Plan['caps']])
}

export interface PlanEditorInput {
  locale?: 'en' | 'ar'
  plan?: Plan
  featureLists: readonly Pick<FeatureList, 'id' | 'name'>[]
  ownerId: string | null
  canManage: boolean
  allowUnlimited: boolean
}

export function renderPlanEditor(input: PlanEditorInput): string {
  const ar = input.locale === 'ar'
  const text = (en: string, arabic: string) => escapeHtml(ar ? arabic : en)
  const seed = input.plan ?? defaultPlan({ featureListId: input.featureLists[0]?.id ?? '', ownerId: input.ownerId })
  const ownerId = input.plan ? input.plan.ownerId : input.ownerId
  const available = input.featureLists.some(list => list.id === seed.featureListId)
  const disabled = !input.canManage || !available
  const number = (field: Field, value: Limit): string => {
    const unlimited = value === 'unlimited'
    const fieldName = escapeHtml(field.key), id = escapeHtml(field.id)
    return `<div class="xp-field"><label class="xp-label" for="${id}">${escapeHtml(field.label[ar ? 1 : 0])}</label><input class="xp-input xp-mono" type="number" id="${id}" name="${fieldName}" dir="ltr" inputmode="decimal" min="${field.min / field.scale}" max="${field.max / field.scale}" step="${1 / field.scale}"${unlimited ? ' disabled' : ' required'} value="${unlimited ? '' : value / field.scale}" /><label class="xp-plan-cap-option" for="${id}-unlimited"><input id="${id}-unlimited" type="checkbox" name="unlimited.${fieldName}" data-plan-unlimited="${fieldName}"${unlimited ? ' checked' : ''}${input.allowUnlimited ? '' : ' disabled'} /><span>${text('Unlimited', 'غير محدود')}</span></label></div>`
  }
  const group = (title: Copy, fields: readonly Field[], value: (key: string) => Limit) => `<fieldset class="xp-card xp-form-group"><legend class="xp-section-title">${escapeHtml(title[ar ? 1 : 0])}</legend>${fields.map(field => number(field, value(field.key))).join('')}</fieldset>`
  const planId = input.plan ? ` data-plan-id="${escapeHtml(input.plan.id)}"` : ''
  return `<form class="xp-form-group" action="/api/plans" method="post" data-native-plan-editor data-plan-owner="${escapeHtml(ownerId ?? '')}" data-plan-editable="${disabled ? 'false' : 'true'}"${planId}>
    <h2 class="xp-section-title">${text(input.plan ? 'Edit plan' : 'Create plan', input.plan ? 'تعديل الخطة' : 'إنشاء خطة')}</h2>
    ${disabled ? `<p class="xp-help">${text(!input.canManage ? 'This plan is read only.' : 'The feature list is unavailable. Saving is disabled.', !input.canManage ? 'هذه الخطة للقراءة فقط.' : 'قائمة الميزات غير متاحة. الحفظ معطل.')}</p>` : ''}
    <fieldset class="xp-form-group" style="gap:var(--xp-space-card)"${disabled ? ' disabled' : ''}>
      <div class="xp-form-group" style="min-inline-size:0">
      <div class="xp-field"><label class="xp-label" for="plan-name">${text('Plan Name', 'اسم الخطة')}</label><input id="plan-name" name="name" type="text" class="xp-input" required maxlength="64" pattern="${escapeHtml(PLAN_NAME_PATTERN)}" value="${input.plan ? escapeHtml(seed.name) : ''}" /></div>
      <div class="xp-field"><label class="xp-label" for="plan-feature-list">${text('Feature list', 'قائمة الميزات')}</label><select id="plan-feature-list" name="featureListId" class="xp-select" required>${available ? '' : `<option value="" selected>${text('Unavailable', 'غير متاح')}</option>`}${input.featureLists.map(list => `<option value="${escapeHtml(list.id)}"${list.id === seed.featureListId ? ' selected' : ''}>${escapeHtml(formatDisplayName(list.name))}</option>`).join('')}</select></div>
      </div>
      ${group(['Resources', 'الموارد'], PLAN_RESOURCE_FIELDS, key => seed.resources[key as keyof Plan['resources']])}
      ${group(['Service limits', 'حدود الخدمات'], PLAN_CAP_FIELDS, key => seed.caps[key as keyof Plan['caps']])}
      <fieldset class="xp-card xp-form-group"><legend class="xp-section-title">${text('Access and mailbox defaults', 'الوصول وإعدادات البريد الافتراضية')}</legend>
        <div class="xp-field"><label class="xp-label" for="plan-shell-toggle">${text('Jailed shell access', 'وصول الطرفية المعزولة')}</label><select id="plan-shell-toggle" name="shell" class="xp-select"><option value="none"${seed.shell === 'none' ? ' selected' : ''}>${text('Disabled', 'معطل')}</option><option value="jailed"${seed.shell === 'jailed' ? ' selected' : ''}>${text('Jailed shell', 'طرفية معزولة')}</option></select></div>
        <label class="xp-plan-cap-option" for="plan-dedicated-ip"><input id="plan-dedicated-ip" name="dedicatedIp" type="checkbox"${seed.dedicatedIp ? ' checked' : ''} /><span>${text('Dedicated IPv4 required', 'اشتراط عنوان IPv4 مخصص')}</span></label>
        ${number(PLAN_QUOTA_FIELD, seed.defaultMailboxQuotaMb)}
      </fieldset>
    </fieldset>
    <p class="xp-help" data-native-plan-status role="status" aria-live="polite" tabindex="-1" hidden></p>
    <button type="submit" class="xp-btn xp-btn--primary" data-native-plan-save disabled>${text('Save plan', 'حفظ الخطة')}</button>
  </form>`
}

function bindPlanEditorForms(): void {
  document.querySelectorAll<HTMLFormElement>('[data-native-plan-editor]').forEach(form => {
    const save = form.querySelector<HTMLButtonElement>('[data-native-plan-save]')
    const status = form.querySelector<HTMLElement>('[data-native-plan-status]')
    if (!save || !status) return
    const ar = document.documentElement.lang === 'ar'
    const copy = (en: string, arabic: string) => ar ? arabic : en
    const editable = form.dataset.planEditable === 'true'
    let busy = false, reviewRequired = false
    const owner = form.dataset.planOwner || null
    const values = (): PlanEditorValues => Object.fromEntries(Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name],select[name]')).map(control => [control.name, control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value]))
    const signature = (): string => { try { return JSON.stringify(planEditorPayload(values(), owner)) } catch { return JSON.stringify(values()) } }
    let baseline = signature()
    const note = (message: string, state: string) => { status.textContent = message; status.hidden = false; status.dataset.state = state; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const refresh = () => {
      form.querySelectorAll<HTMLInputElement>('[data-plan-unlimited]').forEach(toggle => {
        const control = form.elements.namedItem(toggle.dataset.planUnlimited || '')
        if (control instanceof HTMLInputElement) { control.disabled = toggle.checked || !editable; control.required = !toggle.checked }
      })
      save.disabled = !editable || busy || reviewRequired || signature() === baseline
    }
    form.addEventListener('input', refresh)
    form.addEventListener('change', refresh)
    window.addEventListener('beforeunload', event => {
      if (signature() === baseline && !reviewRequired) return
      event.preventDefault(); event.returnValue = ''
    })
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (!editable || busy || reviewRequired || signature() === baseline || !form.reportValidity()) return
      let payload: PlanEditorPayload
      try { payload = planEditorPayload(values(), owner) } catch (error) {
        const field = error instanceof Error ? error.message : ''
        const control = form.elements.namedItem(field)
        note(copy('Check the plan values. No changes were sent.', 'راجع قيم الخطة. لم تُرسل تغييرات.'), 'failed')
        if (control instanceof HTMLElement) control.focus()
        return
      }
      const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body: unknown) => Promise<unknown> }).xpanelSessionRequest
      if (typeof request !== 'function') { note(copy('Saving is unavailable. No changes were sent.', 'الحفظ غير متاح. لم تُرسل تغييرات.'), 'failed'); return }
      const id = form.dataset.planId
      if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) { note(copy('The saved plan could not be identified.', 'تعذر تحديد الخطة المحفوظة.'), 'failed'); return }
      const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')).map(control => ({ control, disabled: control.disabled }))
      busy = true; form.setAttribute('aria-busy', 'true'); controls.forEach(({ control }) => { control.disabled = true })
      note(copy('Saving…', 'جارٍ الحفظ…'), 'loading')
      const operation = planEditorRequest(payload, id)
      Promise.resolve().then(() => request(operation.method, operation.path, operation.body)).then(result => {
        const receipt = result as { plan?: Plan; reconcile?: { status?: string } } | null
        const persisted = receipt?.plan
        if (!planEditorReceiptMatches(persisted, payload, id)) { reviewRequired = true; note(copy('The result could not be verified. Review plans before retrying.', 'تعذر التحقق من النتيجة. راجع الخطط قبل إعادة المحاولة.'), 'failed'); return }
        form.dataset.planId = persisted.id; baseline = JSON.stringify(payload)
        note(copy(id ? 'Plan saved. Hosting verification is not confirmed.' : 'Plan saved as desired configuration.', id ? 'حُفظت الخطة. التحقق من الاستضافة غير مؤكد.' : 'حُفظت الخطة كإعدادات مطلوبة.'), id ? 'pending' : 'saved')
      }).catch((error: { status?: number; details?: { stateChanged?: boolean; verificationRequired?: boolean } }) => {
        reviewRequired = error?.details?.stateChanged === true || error?.details?.verificationRequired === true || ![400, 401, 403, 404, 409, 412, 422].includes(error?.status ?? 0)
        note(reviewRequired ? copy('The result is uncertain. Review plans before retrying.', 'النتيجة غير مؤكدة. راجع الخطط قبل إعادة المحاولة.') : copy('The plan was refused. Review its values and permissions.', 'رُفضت الخطة. راجع القيم والصلاحيات.'), 'failed')
      }).finally(() => {
        busy = false; form.removeAttribute('aria-busy'); controls.forEach(({ control, disabled }) => { control.disabled = disabled }); refresh()
      })
    })
    refresh()
  })
}

export const PLAN_EDITOR_CLIENT_SCRIPT = `(() => { const PLAN_NAME_PATTERN = ${JSON.stringify(PLAN_NAME_PATTERN)}; const PLAN_RESOURCE_FIELDS = ${JSON.stringify(PLAN_RESOURCE_FIELDS)}; const PLAN_CAP_FIELDS = ${JSON.stringify(PLAN_CAP_FIELDS)}; const PLAN_QUOTA_FIELD = ${JSON.stringify(PLAN_QUOTA_FIELD)}; ${planEditorPayload.toString()}; ${planEditorRequest.toString()}; ${planEditorReceiptMatches.toString()}; (${bindPlanEditorForms.toString()})(); })();`
