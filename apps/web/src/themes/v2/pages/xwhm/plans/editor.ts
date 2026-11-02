import { defaultPlan, PLAN_CAP_RULES, RESOURCE_RULES, type Limit, type Plan } from '@xpanel/core'
import type { Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { formField } from '../../../components/form-field.ts'
import { tabs, tabPanel } from '../../../components/tabs.ts'
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
  const resources = '<fieldset id="v2-plan-resources"><legend>' + escapeHtml(t('Resources')) + '</legend><div class="v2-plan-fields">' + resourceFields.map(field => number(field.key, field.id, field.label, seed.resources[field.key], RESOURCE_RULES[field.key].min, RESOURCE_RULES[field.key].max, field.scale)).join('') + '</div></fieldset>'
  const resourceOptions = '<fieldset><legend>' + escapeHtml(t('Resources')) + '</legend><label class="v2-plan-choice"><input id="plan-dedicated-ip" name="dedicatedIp" type="checkbox"' + (seed.dedicatedIp ? ' checked' : '') + (disabled ? ' disabled' : '') + '>' + escapeHtml(t('Dedicated IPv4 required')) + '</label><label class="v2-plan-choice"><input id="plan-enforce-bandwidth" name="enforceBandwidth" type="checkbox"' + (seed.enforceBandwidth ? ' checked' : '') + (disabled ? ' disabled' : '') + '>' + escapeHtml(t('Serve the bandwidth-exceeded page once the monthly bandwidth is used')) + '</label></fieldset>'
  const caps = '<fieldset id="v2-plan-caps"><legend>' + escapeHtml(t('Service limits')) + '</legend><div class="v2-plan-fields">' + Object.entries(PLAN_CAP_RULES).map(([key, rule]) => number(key, 'plan-' + key, capLabels[key as keyof Plan['caps']], seed.caps[key as keyof Plan['caps']], rule.min, rule.max)).join('') + '</div></fieldset>'
  const quota = '<fieldset><legend>' + escapeHtml(t('Access and mailbox defaults')) + '</legend>' + number('defaultMailboxQuotaMb', 'plan-mailbox-quota', msgid('Default mailbox quota (MiB)'), seed.defaultMailboxQuotaMb, RESOURCE_RULES.diskMb.min, RESOURCE_RULES.diskMb.max) + '</fieldset>'
  const featureList = formField({ id: 'plan-feature-list', label: t('Feature list'), control: { kind: 'select', name: 'featureListId', required: true, disabled, options: [...(!available ? [{ value: '', label: t('Unavailable'), selected: true }] : []), ...lists.map(list => ({ value: list.id, label: list.name, selected: list.id === seed.featureListId }))] } })
  const access = '<fieldset id="v2-plan-access"><legend>' + escapeHtml(t('Access')) + '</legend>' + featureList + formField({ id: 'plan-shell-toggle', label: t('Jailed shell access'), control: { kind: 'select', name: 'shell', disabled, options: [{ value: 'none', label: t(msgctxt('plan-editor', 'Disabled')), selected: seed.shell === 'none' }, { value: 'jailed', label: t('Jailed shell'), selected: seed.shell === 'jailed' }] } }) + '</fieldset>'
  const name = '<div class="v2-plan-field"><label for="plan-name">' + escapeHtml(t('Plan Name')) + '</label><input id="plan-name" name="name" type="text" required maxlength="64" pattern="' + escapeHtml(PLAN_NAME_PATTERN) + '" value="' + (selected ? escapeHtml(seed.name) : '') + '"' + (disabled ? ' disabled' : '') + '></div>'
  const sections = [
    { key: 'resources', label: t('Resources'), body: resources + resourceOptions },
    { key: 'services', label: t('Services'), body: caps + quota },
    { key: 'features', label: t(msgctxt('theme:v2', 'Features')), body: access },
  ]
  const navigation = tabs({ label: t(selected ? msgid('Edit plan') : msgid('Create plan')), tabs: sections.map((section, index) => ({ id: 'v2-plan-tab-' + section.key, panelId: 'v2-plan-panel-' + section.key, label: section.label, selected: index === 0, hooks: { 'data-presentation-tab': section.key } })) })
  const panels = sections.map((section, index) => tabPanel({ id: 'v2-plan-panel-' + section.key, tabId: 'v2-plan-tab-' + section.key, hidden: index !== 0, sectionSpacing: true, bodyHtml: '<fieldset' + (disabled ? ' disabled' : '') + '>' + section.body + '</fieldset>' })).join('')
  const reviewFields = [
    ['name', msgid('Plan Name'), false], ['featureListId', msgid('Feature list'), false],
    ...resourceFields.map(field => [field.key, field.label, true] as const),
    ...Object.entries(capLabels).map(([key, label]) => [key, label, true] as const),
    ['shell', msgid('Jailed shell access'), false], ['dedicatedIp', msgid('Dedicated IPv4 required'), false],
    ['enforceBandwidth', msgid('Serve the bandwidth-exceeded page once the monthly bandwidth is used'), false], ['defaultMailboxQuotaMb', msgid('Default mailbox quota (MiB)'), true],
  ] as const
  const rows = reviewFields.map(([key, label, numeric]) => '<li data-plan-review-key="' + escapeHtml(key) + '" hidden><span class="v2-plan-review-label">' + escapeHtml(t(label)) + '</span><dl class="v2-plan-review-values v2-plan-fields"><div><dt>' + escapeHtml(t(msgctxt('theme:v2', 'Current'))) + '</dt><dd><bdi dir="auto"' + (numeric ? ' class="v2-mono v2-num"' : '') + ' data-plan-review-from>' + escapeHtml(t('Not read')) + '</bdi></dd></div><div><dt>' + escapeHtml(t(msgctxt('theme:v2', 'Proposed'))) + '</dt><dd><bdi dir="auto"' + (numeric ? ' class="v2-mono v2-num"' : '') + ' data-plan-review-to>' + escapeHtml(t('Not read')) + '</bdi></dd></div></dl></li>').join('')
  const review = '<section class="v2-plan-section" data-native-plan-review data-plan-review-readable="' + readable + '" data-plan-review-saved="' + Boolean(selected) + '" data-state="unread" hidden><ol class="v2-plan-review-steps" aria-label="' + escapeHtml(t('Review changes')) + '"><li><bdi dir="ltr">1</bdi> ' + escapeHtml(t('Edit')) + '</li><li aria-current="step"><bdi dir="ltr">2</bdi> ' + escapeHtml(t('Review')) + '</li><li><bdi dir="ltr">3</bdi> ' + escapeHtml(t('Apply')) + '</li></ol><h3>' + escapeHtml(t(msgctxt('theme:v2', 'Review changes'))) + '</h3><p role="status" data-plan-review-status>' + escapeHtml(t('Not read')) + '</p><span class="v2-num" data-plan-review-count>0</span><ul class="v2-plan-review-rows" data-plan-review-rows>' + rows + '</ul><p data-plan-review-empty>' + escapeHtml(t('Not read')) + '</p></section>'
  const styles = '<style>.v2-plan-editor [hidden]{display:none!important}.v2-plan-editor .v2-plan-review-rows{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:16px}.v2-plan-editor .v2-plan-review-rows>li{display:flex;flex-direction:column;gap:8px}.v2-plan-editor .v2-plan-review-label{font-weight:600}.v2-plan-editor .v2-plan-review-values{margin:0}.v2-plan-editor .v2-plan-review-values>div{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--subtle);min-inline-size:0}.v2-plan-editor .v2-plan-review-values>div+div{background:var(--accent-soft);border-color:var(--accent-line)}.v2-plan-editor .v2-plan-review-values :is(dt,dd){margin:0;overflow-wrap:anywhere}.v2-plan-editor .v2-plan-review-values dt{color:var(--muted);font-size:12px}.v2-plan-editor .v2-plan-review-steps{display:flex;flex-wrap:wrap;gap:16px;list-style:none;margin:0;padding:0}.v2-plan-editor .v2-plan-review-steps li{display:flex;align-items:center;gap:8px}</style>'
  return '<form class="v2-plan-editor" action="/api/plans" method="post" data-native-plan-editor data-plan-owner="' + escapeHtml((selected ? selected.ownerId : authority.ownerId) ?? '') + '" data-plan-editable="' + (disabled ? 'false' : 'true') + '"' + (selected ? ' data-plan-id="' + escapeHtml(selected.id) + '"' : '') + '>' + styles + '<h2>' + escapeHtml(t(selected ? msgid('Edit plan') : msgid('Create plan'))) + '</h2>' + (disabled ? '<p role="status">' + escapeHtml(t(!editable ? msgid('This plan is read only.') : msgid('The feature list is unavailable. Saving is disabled.'))) + '</p>' : '') + '<div data-plan-review-editor>' + name + '<div data-presentation-tabs="panels">' + navigation + panels + '</div></div>' + review + '<p data-native-plan-status role="status" aria-live="polite" tabindex="-1" hidden></p><p role="status" aria-live="polite" data-plan-review-summary>' + escapeHtml(t('Not read')) + '</p><div class="v2-plan-actions">' + (disabled ? button(t('Discard changes'), undefined, { disabled: true }) : '<a class="v2-btn" href="' + escapeHtml(planHref(props, selected?.id)) + '">' + escapeHtml(t('Discard changes')) + '</a>') + '<span data-plan-review-open-wrap>' + button(t(msgctxt('theme:v2', 'Review and apply')), { 'data-plan-review-open': true }, { disabled: true, primary: true }) + '</span><span data-plan-review-back-wrap hidden>' + button(t(msgctxt('theme:v2', 'Back to editing')), { 'data-plan-review-back': true }, { disabled: true }) + '</span><span data-plan-review-save-wrap hidden>' + button(t('Save plan'), { 'data-native-plan-save': true }, { type: 'submit', disabled: true, primary: true }) + '</span></div></form>'
}
