import { type Locale, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

type Copy = string
/** Rules table rows in health-check order. A row with a unit has a threshold (bounds come from the API); the others fire on a health warning or problem. */
export const MONITORING_ALERT_ROWS: readonly { id: string; title: Copy; unit: Copy | null }[] = [
  { id: 'load', title: msgid('Load per processor'), unit: msgid('per processor') },
  { id: 'memory', title: msgid('Available memory'), unit: msgid('% available') },
  { id: 'swap', title: msgid('Swap use'), unit: msgid('% used') },
  { id: 'disk-space', title: msgid('Disk space per filesystem'), unit: msgid('% used') },
  { id: 'disk-inodes', title: msgid('Inodes per filesystem'), unit: msgid('% used') },
  { id: 'services', title: msgid('Failed services'), unit: null },
  { id: 'drift', title: msgid('Configuration drift'), unit: null },
  { id: 'certificates', title: msgid('Certificates expiring'), unit: msgid('days left') },
  { id: 'reboot', title: msgid('Reboot required'), unit: null },
]

const STYLE = `<style>.xp-whm-alerts{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-alerts :is(h2,h3,p,dl,dd,ul,pre,fieldset){margin:0}.xp-whm-alerts__group{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-whm-alerts .xp-whm-detail-table{min-inline-size:56rem}.xp-whm-alerts .xp-whm-detail-table :is(th,td){overflow-wrap:normal;word-break:normal}.xp-whm-alerts .xp-whm-detail-table thead th{white-space:nowrap}.xp-whm-alerts__facts dd{overflow-wrap:anywhere}.xp-whm-alerts__threshold{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.xp-whm-alerts__threshold input{inline-size:112px;min-block-size:44px;box-sizing:border-box;font:inherit;border:1px solid var(--xp-border-strong,#d0d5dd);border-radius:8px;background:var(--xp-bg-surface);color:inherit;padding:10px 12px;text-align:start}.xp-whm-alerts__quiet{display:flex;flex-direction:column;gap:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;padding:16px;min-inline-size:0}.xp-whm-alerts__quiet legend{padding-inline:8px;font-weight:600}.xp-whm-alerts__list{display:flex;flex-direction:column;gap:16px;padding:0;list-style:none;min-inline-size:0}.xp-whm-alerts__result{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;min-inline-size:0}.xp-whm-alerts__result[data-severity="critical"]{border-color:var(--xp-danger,#b42318)}.xp-whm-alerts__result[data-severity="warning"]{border-color:var(--xp-warning,#b54708)}.xp-whm-alerts__head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between}.xp-whm-alerts__head h3{font-size:16px;line-height:1.6;overflow-wrap:anywhere}.xp-whm-alerts__badges{display:flex;flex-wrap:wrap;gap:8px}.xp-whm-alerts__evidence{max-block-size:240px;overflow:auto;padding:16px;border-radius:8px;background:var(--xp-bg-elevated);white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6;text-align:start}.xp-whm-alerts details{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-alerts summary{cursor:pointer;min-block-size:44px;align-content:center;font-weight:600}.xp-whm-alerts details[open]>:not(summary){margin-block-start:8px}.xp-whm-alerts :is(button,a,summary,pre,input):focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}.xp-whm-alerts :disabled{cursor:not-allowed;opacity:.75}</style>`

/** /whm/monitoring/alerts body: delivery state and log, evaluation results and the editable rules. */
export function renderWhmMonitoringAlertsWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const on = input.canManage
  const t = (copy: Copy): string => escapeHtml(translator(input.locale)(copy))
  const off = on ? '' : ' disabled', container = on ? 'form' : 'div'
  const notRead = t(msgid('Not read'))
  const fact = (key: string, label: Copy, value = notRead): string => `<div class="xp-whm-detail-field"><dt>${t(label)}</dt><dd data-whm-alerts-fact="${key}">${value}</dd></div>`
  const card = (key: string, title: Copy, body: string): string => `<section class="xp-whm-detail-card" data-whm-alerts-section="${key}" aria-labelledby="whm-alerts-${key}"><h2 id="whm-alerts-${key}">${t(title)}</h2>${body}</section>`
  const status = (marker: string, copy: Copy): string => `<p class="xp-whm-detail-status" data-whm-alerts-${marker} data-state="${on ? 'unread' : 'unavailable'}" role="status">${t(on ? copy : msgid('Alerts require an authorized root administrator on a qualified host. Nothing was read or changed.'))}</p>`
  const rows = MONITORING_ALERT_ROWS.map(row => `<tr data-whm-alerts-rule="${row.id}"><th scope="row" data-whm-alerts-title>${t(row.title)}</th>`
    + `<td><label class="xp-whm-detail-choice"><input type="checkbox" data-whm-alerts-enabled aria-label="${t(row.title)}: ${t(msgctxt('whm-monitoring-alerts-workspace', 'enabled'))}"${off}><span>${t(msgctxt('whm-monitoring-alerts-workspace', 'Enabled'))}</span></label></td>`
    + `<td>${row.unit ? `<span class="xp-whm-alerts__threshold"><input type="number" inputmode="decimal" dir="ltr" data-whm-alerts-threshold aria-label="${t(row.title)}: ${t(msgid('threshold'))}"${off}><span data-whm-alerts-unit>${t(row.unit)}</span></span>` : t(msgid('No threshold. Fires when the health check reports a warning or a problem.'))}</td>`
    + `<td data-whm-alerts-range>${row.unit ? notRead : '-'}</td></tr>`).join('')
  return `<div class="xp-whm-alerts" data-whm-monitoring-alerts-workspace data-alerts-can-manage="${on}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${STYLE}
  ${card('delivery', msgid('Delivery'), `<p class="xp-help">${t(msgid('A firing alert is sent once when it starts and once when it clears, by email and to the webhook chosen on the notifications page. Failed messages are retried for about an hour.'))}</p>
    <dl class="xp-whm-detail-fields xp-whm-alerts__facts">
    ${fact('notifications', msgid('Notifications'))}
    ${fact('scheduler', msgid('Background checks'))}
    ${fact('pending', msgid('Waiting to retry'))}
  </dl><div class="xp-whm-detail-actions"><a class="xp-btn" href="/whm/panel/notifications">${t(msgid('Notification settings'))}</a><a class="xp-btn" href="/whm/monitoring/health">${t(msgid('Server health'))}</a></div>
    <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(msgid('Delivery log'))}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t(msgid('Delivery log'))}</caption><thead><tr><th scope="col">${t(msgid('Time (UTC)'))}</th><th scope="col">${t(msgid('Alert'))}</th><th scope="col">${t(msgid('Message'))}</th><th scope="col">${t(msgid('Channel'))}</th><th scope="col">${t(msgid('Result'))}</th></tr></thead>
    <tbody data-whm-alerts-log><tr><td colspan="5" class="xp-help">${t(msgid('No delivery has been read.'))}</td></tr></tbody></table></div>`)}
  ${card('evaluation', msgid('Evaluation'), `<p class="xp-help">${t(msgid('The rules below are evaluated on a schedule. Evaluate now reads the server health checks at once and delivers like a scheduled check. Each result is recorded, so this page shows how long an alert has been firing.'))}</p>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-whm-alerts-evaluate${off}>${t(msgid('Evaluate now'))}</button></div>
    ${status('eval-status', msgid('No evaluation has been read.'))}
    <dl class="xp-whm-detail-fields xp-whm-alerts__facts">${fact('evaluated-at', msgid('Last evaluated (UTC)'))}${fact('observed-at', msgid('Health observed (UTC)'))}${fact('firing', msgid('Firing'))}${fact('unavailable', msgctxt('whm-monitoring-alerts-workspace', 'Not verified'))}${fact('quiet', msgid('Quiet window'))}</dl>
    <ul class="xp-whm-alerts__list" data-whm-alerts-results aria-live="polite"><li class="xp-help">${t(msgid('No results have been read.'))}</li></ul>`)}
  ${card('rules', msgid('Rules'), `${status('status', msgid('Alert rules have not been read.'))}
    <dl class="xp-whm-detail-fields xp-whm-alerts__facts">${fact('updated', msgid('Last saved (UTC)'))}${fact('updated-by', msgid('Saved by'))}</dl>
    <${container} class="xp-whm-alerts__group" data-whm-alerts-form aria-labelledby="whm-alerts-rules"${on ? ' novalidate' : ''}>
      <p class="xp-help">${t(msgid('Each rule reads one server health check. A threshold applies to this alert only; the server health page keeps its fixed levels.'))}</p>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(msgid('Alert rules'))}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t(msgid('Alert rules'))}</caption><thead><tr><th scope="col">${t(msgid('Check'))}</th><th scope="col">${t(msgid('Alert'))}</th><th scope="col">${t(msgid('Threshold'))}</th><th scope="col">${t(msgid('Condition and allowed range'))}</th></tr></thead><tbody>${rows}</tbody></table></div>
      <fieldset class="xp-whm-alerts__quiet" aria-describedby="whm-alerts-quiet-help"${off}>
        <legend>${t(msgid('Quiet window (UTC)'))}</legend>
        <label class="xp-whm-detail-choice"><input type="checkbox" data-whm-alerts-quiet${off}><span>${t(msgid('Use a daily quiet window'))}</span></label>
        <div class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><label for="whm-alerts-quiet-start">${t(msgid('Starts at'))}</label><input id="whm-alerts-quiet-start" type="time" dir="ltr" data-whm-alerts-quiet-start${off}></div><div class="xp-whm-detail-field"><label for="whm-alerts-quiet-end">${t(msgid('Ends at'))}</label><input id="whm-alerts-quiet-end" type="time" dir="ltr" data-whm-alerts-quiet-end${off}></div></div>
        <p class="xp-help" id="whm-alerts-quiet-help">${t(msgid('A firing alert evaluated inside the window is marked quiet and nothing is sent. A change that still holds when the window ends is sent then.'))}</p>
      </fieldset>
      <div class="xp-whm-detail-actions"><button type="${on ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-whm-alerts-save${off}>${t(msgid('Save rules'))}</button><button type="button" class="xp-btn" data-whm-alerts-reload${off}>${t(msgid('Reload'))}</button></div>
      <p class="xp-whm-detail-status" data-whm-alerts-save-status role="status" hidden></p>
    </${container}>`)}
</div>`
}
