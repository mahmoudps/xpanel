import type { Plan } from '@xpanel/core'
import type { Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { escapeHtml } from '../../../html.ts'
import { renderV2PlanEditor } from './editor.ts'
import { DENIED_PLAN_AUTHORITY, button, facts, group, page, planEditable, planFactsReadable, planAccountFactsReadable, planHref, planPrincipal, planReadable, table, technical, type WhmPlanAuthority } from './common.ts'

const limit = (t: Translate, value: number | 'unlimited', unit = ''): string => value === 'unlimited' ? escapeHtml(t('Unlimited')) : technical(`${value}${unit ? ' ' + unit : ''}`)
/** Plan data is desired configuration. Measured use, host apply and browser draft comparison remain separate. */
export function renderV2WhmPlans(t: Translate, props: WhmSurfaceProps, authority: WhmPlanAuthority = DENIED_PLAN_AUTHORITY): string {
  const route = '/whm/plans', readable = planFactsReadable(props, authority, route), principal = planPrincipal(props)
  const plans = readable ? props.plans?.filter(plan => principal?.kind === 'root' || plan.ownerId === null || plan.ownerId === principal?.id) : undefined
  const lists = readable ? props.featureLists?.filter(list => principal?.kind === 'root' || list.ownerId === null || list.ownerId === principal?.id) : undefined
  const observedAccounts = readable && planAccountFactsReadable(authority) ? props.accounts?.filter(account => principal?.kind === 'root' || account.ownerId === principal?.id) : undefined
  const selectedId = props.planEditorState?.kind === 'edit' ? props.planEditorState.plan.id : undefined
  const selected = selectedId ? plans?.find(plan => plan.id === selectedId) : undefined
  const requestedUnavailable = props.planEditorState?.kind === 'unavailable' || selectedId !== undefined && selected === undefined
  const accountCount = (plan: Plan): string => observedAccounts === undefined ? escapeHtml(t('Not read')) : technical(observedAccounts.filter(account => account.planId === plan.id).length)
  const rows = (plans ?? []).map(plan => ({ hooks: { 'data-plan-row': plan.name }, cellsHtml: [
    `<strong data-plan-name>${escapeHtml(plan.name)}</strong>`,
    escapeHtml(plan.ownerId === null ? t('Root') : props.resellers?.find(owner => owner.id === plan.ownerId)?.username ?? t('Not read')),
    limit(t, plan.resources.diskMb, 'MiB'), limit(t, plan.resources.bandwidthMbMonth, 'MiB'),
    `<div class="v2-plan-stack">${limit(t, plan.resources.ioReadBps, 'B/s')}${limit(t, plan.resources.ioWriteBps, 'B/s')}</div>`,
    limit(t, plan.resources.memoryMb, 'MiB'), limit(t, plan.resources.maxProcesses),
    escapeHtml(lists?.find(list => list.id === plan.featureListId)?.name ?? t('Not read')), accountCount(plan),
    planEditable(props, authority, plan) ? `<div class="v2-plan-actions"><a class="v2-btn" href="${escapeHtml(planHref(props, plan.id))}">${escapeHtml(t('Edit'))}</a>${button(t('Delete'), { 'data-plan-delete': plan.id })}</div>` : escapeHtml(t('Read only')),
  ] }))
  const picker = `<ul class="v2-plan-picker">${(plans ?? []).map(plan => `<li><a href="${escapeHtml(planHref(props, plan.id))}"${selected?.id === plan.id ? ' aria-current="page"' : ''}><strong>${escapeHtml(plan.name)}</strong><span>${accountCount(plan)}</span></a></li>`).join('') || `<li role="status">${escapeHtml(t(plans === undefined ? msgid('Plans have not been read.') : msgctxt('theme:v2', 'No plans are available in this authorized snapshot.')))}</li>`}</ul>`
  const add = readable && planEditable(props, authority) ? `<a class="v2-btn v2-btn--primary" href="${escapeHtml(planHref(props))}">${escapeHtml(t('Create plan'))}</a>` : button(t('Create plan'), undefined, { disabled: true, primary: true })
  const editorProps = { ...props, featureLists: lists ?? [] }
  const editor = requestedUnavailable ? `<p role="alert">${escapeHtml(t('The requested plan is unavailable.'))}</p>` : renderV2PlanEditor(t, editorProps, authority, selected, planReadable(props, authority, route) && planEditable(props, authority, selected))
  const impactRows = (plans ?? []).map(plan => ({ cellsHtml: [escapeHtml(plan.name), accountCount(plan), escapeHtml(t('Not read'))] }))
  const assignedRows = observedAccounts?.filter(account => plans?.some(plan => plan.id === account.planId)).map(account => ({ cellsHtml: [escapeHtml(plans!.find(plan => plan.id === account.planId)!.name), technical(account.username), technical(account.primaryDomain)] })) ?? []
  const impact = group('impact', t(msgctxt('theme:v2', 'Impact of changes')), table(t, 'impact', t('Plan impact'), [t('Plan'), t('Assigned accounts in the authorized snapshot'), t('Observed cap compliance')], impactRows, t(msgctxt('theme:v2', 'Plan assignments have not been read.')))
    + `<p>${escapeHtml(t(msgctxt('theme:v2', 'Assignments are desired state. Current usage and over-cap accounts have not been observed.')))}</p>`
    + table(t, 'assigned', t('Assigned accounts'), [t('Plan'), t('Account'), t('Primary domain')], assignedRows, t(observedAccounts === undefined ? msgid('Account assignments have not been read.') : msgid('No assigned accounts were returned in this snapshot.'))))
  const unsaved = group('unsaved', t('Unsaved changes'), `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'Review current values in the plan editor. A saved plan is not a comparison with its browser draft.')))}</p>${facts([{ label: t('Saved'), valueHtml: escapeHtml(selected?.name ?? t('Not read')) }, { label: t('Draft'), valueHtml: escapeHtml(t('Not read')) }])}`)
  const applying = group('applying', t('How saving applies'),
    `<p>${escapeHtml(t('Saving records desired plan state and an audit event. Changes to host resource limits require the reconciler and host evidence; a stored plan alone does not establish that slices were updated.'))}</p>`
    + `<p>${escapeHtml(t('Caps govern later create requests. Lowering a cap must not remove existing files, sites, mailboxes or databases. A saved limit is separate from measured consumption.'))}</p>`)
  const dialog = `<dialog class="v2-plan-dialog" data-plan-delete-dialog aria-labelledby="plan-delete-title"><form method="dialog"><h2 id="plan-delete-title">${escapeHtml(t('Delete plan'))}</h2><p>${escapeHtml(t('Deleting a plan cannot be undone.'))}</p><p data-dialog-status role="status" hidden></p><div class="v2-plan-actions">${button(t('Cancel'), { 'data-dialog-cancel': true })}${button(t('Delete'), undefined, { type: 'submit', primary: true })}</div></form></dialog>`
  const allPlans = group('all', t(msgctxt('theme:v2', 'All plans')), table(t, 'all', t(msgctxt('theme:v2', 'All plans')), [t('Plan'), t('Owner'), t('Disk'), t('Bandwidth / month'), t(msgctxt('theme:v2', 'Disk IO read / write')), t('Memory'), t('Processes'), t('Feature list'), t('Accounts'), t('Actions')], rows, t(plans === undefined ? msgid('Plans have not been read.') : msgid('No plans are available in this authorized snapshot.'))))
  const title = page(t, route, t('Plans'), t('A plan sets each account’s resource limits. Choose Unlimited to remove a limit.'), `<div id="whm-plans" data-section="plans-feature-lists" class="v2-plan-stack"><div class="v2-plan-columns"><aside class="v2-plan-aside">${group('picker', t('Plans'), picker, add)}</aside><div class="v2-plan-main">${group('editor', t(selected ? msgid('Edit plan') : msgid('Create plan')), editor)}${unsaved}${impact}${applying}</div></div>${allPlans}${dialog}</div>`, planReadable(props, authority, route))
  return title
}
