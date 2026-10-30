import { defaultPlan, PLAN_CAP_RULES, RESOURCE_RULES, type Limit, type Plan } from '@xpanel/core'
import type { Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { formField } from '../../../components/form-field.ts'
import { escapeHtml } from '../../../html.ts'
import { button, planFactsReadable, planHref, type WhmPlanAuthority } from './common.ts'

const PLAN_NAME_PATTERN = String.raw`[A-Za-z0-9](?:[A-Za-z0-9 _.\-]{0,62}[A-Za-z0-9_.\-])?`

const resourceFields: readonly { key: keyof Plan['resources']; label: string; id: string; scale: number }[] = [
  { key: 'diskMb', label: msgid('Disk (MiB)'), id: 'plan-diskMb', scale: 1 },
  { key: 'bandwidthMbMonth', label: msgid('Monthly bandwidth (MiB)'), id: 'plan-bandwidthMbMonth', scale: 1 },
  { key: 'ioReadBps', label: msgid('Disk read (MiB/s)'), id: 'plan-ioReadBps', scale: 1024 * 1024 },
  { key: 'ioWriteBps', label: msgid('Disk write (MiB/s)'), id: 'plan-ioWriteBps', scale: 1024 * 1024 },
  { key: 'ioReadIops', label: msgid('Read operations per second'), id: 'plan-ioReadIops', scale: 1 },
  { key: 'ioWriteIops', label: msgid('Write operations per second'), id: 'plan-ioWriteIops', scale: 1 },
  { key: 'memoryMb', label: msgid('Memory (MiB)'), id: 'plan-memory-max', scale: 1 },
  { key: 'maxProcesses', label: msgid('Processes'), id: 'plan-tasks-max', scale: 1 },
  { key: 'cpuPercent', label: msgid('CPU (%)'), id: 'plan-cpu-quota', scale: 1 },
]
const capLabels: Record<keyof Plan['caps'], string> = {
  addonDomains: msgid('Addon domains'), aliasDomains: msgid('Alias domains'), subdomains: msgid('Subdomains'),
  mailboxes: msgid('Mailboxes'), forwarders: msgid('Forwarders'), mailingLists: msgid('Mailing lists'),
  ftpAccounts: msgid('FTP accounts'), databases: msgid('Databases'), phpWorkers: msgid('PHP workers'),
}

export function renderV2PlanEditor(t: Translate, props: WhmSurfaceProps, authority: WhmPlanAuthority, selected: Plan | undefined, editable: boolean): string {
  const readable = planFactsReadable(props, authority, '/whm/plans')
  selected = readable ? selected : undefined
  const lists = readable ? props.featureLists ?? [] : []
  const seed = selected ?? defaultPlan({ featureListId: lists[0]?.id ?? '', ownerId: authority.ownerId })
  const available = lists.some(list => list.id === seed.featureListId)
  const disabled = !readable || authority.presentation === 'read-only' || !editable || !available
  const number = (key: string, id: string, label: string, value: Limit, min: number, max: number, scale = 1): string => {
    const unlimited = value === 'unlimited'
    return `<div class="v2-plan-field"><label for="${id}">${escapeHtml(t(label))}</label><input id="${id}" name="${key}" type="number" dir="ltr" inputmode="decimal" min="${min / scale}" max="${max / scale}" step="${1 / scale}"${unlimited || disabled ? ' disabled' : ' required'} value="${unlimited ? '' : value / scale}"><label class="v2-plan-choice" for="${id}-unlimited"><input id="${id}-unlimited" type="checkbox" name="unlimited.${key}" data-plan-unlimited="${key}"${unlimited ? ' checked' : ''}${disabled || !authority.allowUnlimited ? ' disabled' : ''}><span>${escapeHtml(t('Unlimited'))}</span></label></div>`
  }
  const resources = `<fieldset id="v2-plan-resources"><legend>${escapeHtml(t('Resources'))}</legend><div class="v2-plan-fields">${resourceFields.map(field => number(field.key, field.id, field.label, seed.resources[field.key], RESOURCE_RULES[field.key].min, RESOURCE_RULES[field.key].max, field.scale)).join('')}</div></fieldset>`
  const caps = `<fieldset id="v2-plan-caps"><legend>${escapeHtml(t('Service limits'))}</legend><div class="v2-plan-fields">${Object.entries(PLAN_CAP_RULES).map(([key, rule]) => number(key, `plan-${key}`, capLabels[key as keyof Plan['caps']], seed.caps[key as keyof Plan['caps']], rule.min, rule.max)).join('')}</div></fieldset>`
  const access = `<fieldset id="v2-plan-access"><legend>${escapeHtml(t('Access and mailbox defaults'))}</legend>${formField({ id: 'plan-shell-toggle', label: t('Jailed shell access'), control: { kind: 'select', name: 'shell', disabled, options: [{ value: 'none', label: t(msgctxt('plan-editor', 'Disabled')), selected: seed.shell === 'none' }, { value: 'jailed', label: t('Jailed shell'), selected: seed.shell === 'jailed' }] } })}<label class="v2-plan-choice"><input id="plan-dedicated-ip" name="dedicatedIp" type="checkbox"${seed.dedicatedIp ? ' checked' : ''}${disabled ? ' disabled' : ''}>${escapeHtml(t('Dedicated IPv4 required'))}</label><label class="v2-plan-choice"><input id="plan-enforce-bandwidth" name="enforceBandwidth" type="checkbox"${seed.enforceBandwidth ? ' checked' : ''}${disabled ? ' disabled' : ''}>${escapeHtml(t('Serve the bandwidth-exceeded page once the monthly bandwidth is used'))}</label>${number('defaultMailboxQuotaMb', 'plan-mailbox-quota', msgid('Default mailbox quota (MiB)'), seed.defaultMailboxQuotaMb, RESOURCE_RULES.diskMb.min, RESOURCE_RULES.diskMb.max)}</fieldset>`
  return `<form class="v2-plan-editor" action="/api/plans" method="post" data-native-plan-editor data-plan-owner="${escapeHtml((selected ? selected.ownerId : authority.ownerId) ?? '')}" data-plan-editable="${disabled ? 'false' : 'true'}"${selected ? ` data-plan-id="${escapeHtml(selected.id)}"` : ''}><h2>${escapeHtml(t(selected ? msgid('Edit plan') : msgid('Create plan')))}</h2>${disabled ? `<p role="status">${escapeHtml(t(!editable ? msgid('This plan is read only.') : msgid('The feature list is unavailable. Saving is disabled.')))}</p>` : ''}<fieldset${disabled ? ' disabled' : ''}><div class="v2-plan-fields"><div class="v2-plan-field"><label for="plan-name">${escapeHtml(t('Plan Name'))}</label><input id="plan-name" name="name" type="text" required maxlength="64" pattern="${escapeHtml(PLAN_NAME_PATTERN)}" value="${selected ? escapeHtml(seed.name) : ''}"${disabled ? ' disabled' : ''}></div>${formField({ id: 'plan-feature-list', label: t('Feature list'), control: { kind: 'select', name: 'featureListId', required: true, disabled, options: [...(!available ? [{ value: '', label: t('Unavailable'), selected: true }] : []), ...lists.map(list => ({ value: list.id, label: list.name, selected: list.id === seed.featureListId }))] } })}</div>${resources}${caps}${access}</fieldset><p data-native-plan-status role="status" aria-live="polite" tabindex="-1" hidden></p><div class="v2-plan-actions">${disabled ? button(t('Discard changes'), undefined, { disabled: true }) : `<a class="v2-btn" href="${escapeHtml(planHref(props, selected?.id))}">${escapeHtml(t('Discard changes'))}</a>`}${button(t('Save plan'), { 'data-native-plan-save': true }, { type: 'submit', disabled: true, primary: true })}</div></form>`
}
