import { localeDirection } from '../../../../../i18n.ts'
import { v2Messages } from '../../../messages.ts'
import { lifecycleButton, lifecycleCard, lifecycleFacts, lifecycleField, lifecycleHeader, lifecycleLink, lifecycleStatus, lifecycleTable, text, type LifecycleAccess } from './shared.ts'
import { renderV2BackupDestinationManager } from './destination-manager.ts'

export type V2BackupDestinationsPageProps = LifecycleAccess

/** Destination tests, activation, copies and retention remain controlled by their core lifecycle controllers. */
export function renderV2BackupDestinationsPage(props: V2BackupDestinationsPageProps): string {
  const t = v2Messages.translator(props.locale)
  const manage = props.canRead && props.canManage
  const actions = (body: string): string => `<div class="v2-lifecycle__actions">${body}</div>`
  const runsTable = (key: string, title: string, labels: readonly string[], empty: string, value: number): string => `${lifecycleTable(t, title, labels, { 'data-backup-runs-rows': key }, msgid('Not read'), { value })}<p class="v2-muted" data-backup-runs-empty="${key}" hidden>${text(t, empty)}</p>`
  const runsButton = (key: string, label: string, primary = false): string => lifecycleButton(t, label, { [`data-backup-${key}`]: true }, primary)
  // The run controller refuses to read without its four row templates inside this section.
  const technical = (slot: string): string => `<td><bdi dir="ltr" class="v2-mono" data-xp-slot="${slot}"></bdi></td>`, plain = (slot: string): string => `<td data-xp-slot="${slot}"></td>`
  const runTemplate = (kind: string, cells: string): string => `<template data-xp-template="whm-backup-${kind}-row"><tr>${cells}</tr></template>`
  const runTemplates = runTemplate('runs', technical('started') + plain('trigger') + plain('state') + plain('copies') + plain('mail') + plain('retention'))
    + runTemplate('copies', technical('account') + plain('destination') + technical('archive') + technical('size') + technical('started') + '<td><button type="button" class="v2-btn" data-xp-slot="action" disabled></button></td>')
    + runTemplate('recoveries', technical('started') + technical('account') + technical('archive') + plain('state'))
    + runTemplate('retention', technical('archive') + technical('account') + technical('created') + technical('size') + plain('plan'))
  const history = lifecycleCard(t, 'destination-runs', msgid('Scheduled runs'), `
<p>${text(t, msgctxt('theme:v2', 'A run counts copies only after their bytes and SHA-256 have been verified. Read the returned parts and failure details before treating a run as complete.'))}</p>
${lifecycleStatus(t, msgid('Backup runs have not been read.'), { 'data-backup-runs-status': true, 'data-state': 'unread' })}
<div class="v2-lifecycle__group" data-backup-runs-loading aria-busy="true" aria-label="${text(t, msgid('Loading backup runs'))}" hidden><p>${text(t, msgid('Loading backup runs'))}</p></div>
${lifecycleFacts(t, [
    { key: 'schedule', label: msgid('Schedule') }, { key: 'next', label: msgid('Next scheduled start (UTC)') }, { key: 'last', label: msgid('Last scheduled start (UTC)') },
  ], 'data-backup-runs-fact')}
${actions(runsButton('runs-read', msgid('Read again')) + runsButton('runs-start', msgid('Run backup now'), true))}
${runsTable('runs', msgid('Backup run history'), [msgid('Started (UTC)'), msgid('Trigger'), msgid('State'), msgid('Verified copies'), msgid('Mail'), msgid('Retention')], msgid('No backup run has been recorded.'), 3)}
`)
  const recovery = lifecycleCard(t, 'destination-copies', msgid('Verified remote copies'), `
<p>${text(t, msgid('Recovery downloads one verified copy into the local archive folder of its account and checks its SHA-256 before it appears there. It never replaces an existing local archive. Restore it afterwards from Restore accounts.'))}</p>
${runsTable('copies', msgid('Verified remote copies'), [msgid('Account'), msgid('Destination'), msgid('Archive'), msgid('Size'), msgid('Run started (UTC)'), msgid('Actions')], msgid('No verified remote copy is recorded.'), 4)}
${runsTable('recoveries', msgid('Recoveries'), [msgid('Started (UTC)'), msgid('Account'), msgid('Archive'), msgid('State')], msgid('No recovery has been requested.'), 4)}
`)
  const retention = lifecycleCard(t, 'destination-retention', msgid('Remote retention'), `
<p>${text(t, msgid('Per account, the newest archive, the newest verified copy and the newest archives up to the schedule retention count are always kept. Only older archives past the destination retention days are deleted. Scheduled runs apply this after every copy is verified.'))}</p>
${lifecycleField(t, 'v2-backup-retention-destination', msgid('Destination'), `<select id="v2-backup-retention-destination" data-backup-retention-destination disabled><option value="">${text(t, msgid('Not read'))}</option></select>`)}
${actions(runsButton('retention-preview', msgid('Review retention')) + runsButton('retention-apply', msgid('Delete expired archives')))}
${lifecycleStatus(t, '', { 'data-backup-retention-status': true }, true)}
${runsTable('retention', msgid('Retention plan'), [msgid('Archive'), msgid('Account'), msgid('Created (UTC)'), msgid('Size'), msgctxt('acct-backup-runs-workspace', 'Plan')], msgid('No xPanel archive was found at this destination.'), 5)}
`)
  return `<div class="v2-lifecycle" data-whm-detail-route="/whm/backups/destinations" data-capability-state="${props.canRead ? 'authorized' : 'unavailable'}" lang="${props.locale}" dir="${localeDirection(props.locale)}">
${lifecycleHeader(t, msgid('Backup destinations'), '/whm/backups/destinations', msgctxt('theme:v2', 'Save inactive destinations, verify their transport and review actual remote copies before recovery or retention.'), lifecycleLink(t, msgid('Server backups'), `/whm/backups?lang=${props.locale}`))}
${renderV2BackupDestinationManager(props, { after: `<section class="v2-lifecycle__column" data-whm-backup-runs data-can-manage="${manage}" aria-label="${text(t, msgid('Backup run history'))}">${history}${recovery}${retention}${runTemplates}</section>` })}</div>`
}
