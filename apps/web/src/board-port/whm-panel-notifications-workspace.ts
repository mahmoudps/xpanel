import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** Labels for the events the API (panel-notifications.ts) accepts; a test keeps both lists equal. */
export const PANEL_NOTIFICATION_EVENT_LABELS: Readonly<Record<string, string>> = {
  'monitoring.alert': msgid('Monitoring alert fired or resolved'),
  'auth.lockout': msgid('Sign-in locked after repeated failures'),
  'auth.login_failed': msgid('Failed sign-in'),
  'auth.2fa_disabled': msgid('Two-factor authentication disabled'),
  'reconcile.failed': msgid('Host configuration apply failed'),
  'reconcile.rolled_back': msgid('Host configuration rolled back'),
  'upgrade.handoff_failed': msgid('Panel upgrade handoff failed'),
  'agent.internal_error': msgid('Host agent internal error'),
  'api.internal_error': msgid('Panel API internal error'),
}

const styles = `<style>.xp-whm-notifications :is(h3,p,fieldset){margin:0}.xp-whm-notifications__group{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-whm-notifications__events{display:flex;flex-direction:column;gap:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;padding:16px;min-inline-size:0}.xp-whm-notifications__events legend{padding-inline:8px;font-weight:600}.xp-whm-notifications__events .xp-whm-detail-choice span{display:flex;flex-direction:column;gap:8px}.xp-whm-notifications__loading{display:flex;flex-direction:column;gap:8px}.xp-whm-notifications__facts dd{overflow-wrap:anywhere}.xp-whm-notifications__url{inline-size:100%;max-inline-size:40rem;min-block-size:44px;box-sizing:border-box;font:inherit;border:1px solid var(--xp-border-strong,#d0d5dd);border-radius:8px;background:var(--xp-bg-surface);color:inherit;padding:10px 12px}.xp-whm-notifications__secret{display:block;margin-block-start:8px;padding:8px 12px;border-radius:8px;background:var(--xp-bg-elevated);overflow-wrap:anywhere;user-select:all}.xp-whm-notifications :is(button,input,textarea):focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}</style>`

/** Complete /whm/panel/notifications page body: delivery and test message, saved recipients, webhook and events. */
export function renderWhmPanelNotificationsWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const disabled = input.canManage ? '' : ' disabled'
  const container = input.canManage ? 'form' : 'div'
  const fact = (key: string, label: string, initial: string): string => `<div class="xp-whm-detail-field"><dt>${label}</dt><dd data-whm-notifications-field="${key}">${initial}</dd></div>`
  const events = Object.entries(PANEL_NOTIFICATION_EVENT_LABELS).map(([key, label]) => `<label class="xp-whm-detail-choice"><input type="checkbox" name="events" value="${key}" data-whm-notifications-event${disabled}><span><span>${t(label)}</span><bdi dir="ltr" class="xp-help">${key}</bdi></span></label>`).join('')
  return `${styles}<section class="xp-whm-detail xp-whm-notifications" data-whm-detail-route="/whm/panel/notifications" data-whm-panel-notifications-workspace data-notifications-can-manage="${input.canManage}" data-capability-state="${input.canManage ? 'authorized' : 'unavailable'}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <header class="xp-whm-detail-heading"><h1>${t('Notifications')}</h1><p>${t('Who should hear about host events, and which events. Monitoring alerts are sent by email and to a signed webhook; the other events are not sent yet.')}</p></header>
  <div class="xp-whm-detail-column">
    <section class="xp-whm-detail-card" data-whm-detail-section="notifications-delivery" aria-labelledby="whm-notifications-delivery-heading">
      <h2 id="whm-notifications-delivery-heading">${t('Delivery')}</h2>
      <dl class="xp-whm-detail-fields xp-whm-notifications__facts">
        ${fact('events', t('Event delivery'), t('Monitoring alerts are sent when that event is selected below. The other events are written to the audit log, but none of them sends a message yet.'))}
        ${fact('channels', t('Channels'), t('Email through this server\'s own mail transfer agent, and an HTTPS webhook signed with HMAC-SHA256.'))}
        ${fact('test', t('Test message'), t('Not read'))}
      </dl>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-notifications-test aria-describedby="whm-notifications-test-help" disabled>${t('Send test message')}</button></div>
      <p class="xp-help" id="whm-notifications-test-help">${t('Sends one message to every saved recipient and to the enabled webhook. Each result is shown here and in the alerts delivery log.')}</p>
      <p class="xp-whm-detail-status" data-whm-notifications-test-status role="status" hidden></p>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="notifications-settings" aria-labelledby="whm-notifications-settings-heading">
      <h2 id="whm-notifications-settings-heading">${t('Recipients and events')}</h2>
      <p class="xp-whm-detail-status" data-whm-notifications-status data-state="unread" role="status">${t('Notification settings have not been read. No recipient or event is assumed.')}</p>
      <div class="xp-whm-notifications__loading" data-whm-notifications-loading aria-busy="true" aria-label="${t('Loading notification settings')}" hidden><span class="xp-skeleton-line"></span><span class="xp-skeleton-line xp-skeleton-line--short"></span></div>
      <dl class="xp-whm-detail-fields xp-whm-notifications__facts">${fact('updated', t('Last saved (UTC)'), t('Not read'))}${fact('updatedBy', t('Saved by'), t('Not read'))}</dl>
      <${container} class="xp-whm-notifications__group" data-whm-notifications-form aria-labelledby="whm-notifications-settings-heading"${input.canManage ? ' novalidate' : ''}>
        <div class="xp-whm-detail-fields">
          <div class="xp-whm-detail-field"><label for="whm-notifications-recipients">${t('Recipients')}</label><textarea id="whm-notifications-recipients" name="recipients" dir="ltr" rows="4" maxlength="2600" spellcheck="false" autocomplete="off" placeholder="ops@example.com" aria-describedby="whm-notifications-recipients-help" data-whm-notifications-recipients${disabled}></textarea><p class="xp-help" id="whm-notifications-recipients-help">${t('Email addresses, one per line or comma-separated, up to 10.')}</p></div>
        </div>
        <fieldset class="xp-whm-notifications__events" aria-describedby="whm-notifications-webhook-help"${disabled}>
          <legend>${t('Webhook')}</legend>
          <p class="xp-help" id="whm-notifications-webhook-help">${t('Each message is an HTTPS POST of JSON. The x-xpanel-signature header holds the Unix time t and v1, the HMAC-SHA256 of t, a dot and the body, made with the signing key. Only public HTTPS addresses are accepted.')}</p>
          <label class="xp-whm-detail-choice"><input type="checkbox" data-whm-notifications-webhook-enabled${disabled}><span>${t('Send to the webhook')}</span></label>
          <div class="xp-whm-detail-field"><label for="whm-notifications-webhook-url">${t('Webhook URL')}</label><input id="whm-notifications-webhook-url" class="xp-whm-notifications__url" type="url" dir="ltr" maxlength="2048" spellcheck="false" autocomplete="off" placeholder="https://hooks.example.com/xpanel" data-whm-notifications-webhook-url${disabled}></div>
          <dl class="xp-whm-detail-fields xp-whm-notifications__facts">${fact('signingKey', t('Signing key'), t('Not read'))}</dl>
          <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-notifications-key${disabled}>${t('Create signing key')}</button></div>
          <p class="xp-whm-detail-status" data-whm-notifications-key-status role="status" hidden></p>
        </fieldset>
        <fieldset class="xp-whm-notifications__events" aria-describedby="whm-notifications-events-help"${disabled}>
          <legend>${t('Events')}</legend>
          <p class="xp-help" id="whm-notifications-events-help">${t('Only events xPanel records today are listed. Selecting an event requires at least one recipient or an enabled webhook.')}</p>
          <div class="xp-whm-detail-choice-grid">${events}</div>
        </fieldset>
        <div class="xp-whm-detail-actions"><button type="${input.canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-whm-notifications-save${disabled}>${t('Save settings')}</button><button type="button" class="xp-btn" data-whm-notifications-reload${disabled}>${t('Reload')}</button></div>
        <p class="xp-whm-detail-status" data-whm-notifications-save-status role="status" hidden></p>
      </${container}>
    </section>
  </div>
</section>`
}
