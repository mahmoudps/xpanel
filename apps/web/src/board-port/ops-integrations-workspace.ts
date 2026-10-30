import { classicOpsClientTemplates } from '../themes/classic/ops-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'

/** Signed webhook integrations for the developer/integrations workspace. Filled by OPS_INTEGRATIONS_CLIENT_BINDING. */
export function renderOpsIntegrationsWorkspace(input: { locale: Locale; canRead: boolean; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const headers = [t('Endpoint'), t('Events'), t('Signing secret'), t('Active'), t('Actions')]
  const logHeaders = [t('Delivery'), t('Event'), t('Result'), t('Attempts'), t('Last status')]
  return `<div class="xp-ops-integrations" data-ops-integrations-workspace data-int-can-read="${input.canRead}" data-int-can-manage="${input.canRead && input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    <style>.xp-ops-integrations{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-ops-integrations :is(h2,p,dl,dd){margin:0}.xp-ops-integrations__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px}.xp-ops-integrations__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-ops-integrations .xp-whm-detail-table th{white-space:nowrap}.xp-ops-integrations__events{display:flex;flex-wrap:wrap;gap:8px}</style>
    <section class="xp-whm-detail-card" data-whm-detail-section="int-state" aria-labelledby="ops-int-state">
      <h2 id="ops-int-state">${t('Webhooks')}</h2>
      <p class="xp-whm-detail-status" data-ops-int-status data-state="${input.canRead ? 'unread' : 'unavailable'}" role="status">${input.canRead ? t('No webhook configuration has been read.') : t('Integrations require an authorized root administrator. Nothing was read or changed.')}</p>
      <dl class="xp-ops-integrations__facts">
        <div><dt>${t('Signature scheme')}</dt><dd><bdi dir="ltr" data-ops-int-fact="scheme">${t('Not read')}</bdi></dd></div>
        <div><dt>${t('Outbound delivery')}</dt><dd><span data-ops-int-fact="egress">${t('Not read')}</span></dd></div>
        <div><dt>${t('Signing secrets')}</dt><dd><bdi dir="ltr" data-ops-int-fact="secrets">${t('Not read')}</bdi></dd></div>
      </dl>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-ops-int-action="read"${input.canRead ? '' : ' disabled'}>${t('Read webhooks')}</button></div>
      <p class="xp-help">${t('Each endpoint is signed with HMAC-SHA256 over a timestamped body. Secrets are stored on the server and never shown here. Failed deliveries are retried on a fixed schedule and recorded in the delivery log.')}</p>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="int-list" aria-labelledby="ops-int-list">
      <h2 id="ops-int-list">${t('Endpoints')}</h2>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Webhook endpoints')}"><table class="xp-whm-detail-table"><caption class="xp-sr-only">${t('Webhook endpoints')}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-ops-int-rows><tr><td colspan="5">${t('No webhook configuration has been read.')}</td></tr></tbody></table></div>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="int-add" data-ops-int-editor aria-labelledby="ops-int-add" hidden>
      <h2 id="ops-int-add">${t('Add an endpoint')}</h2>
      <div class="xp-whm-detail-fields">
        <div class="xp-whm-detail-field"><label for="ops-int-url">${t('Payload URL (https)')}</label><input id="ops-int-url" data-ops-int-url type="url" dir="ltr" placeholder="https://hooks.example.com/xpanel" disabled></div>
      </div>
      <fieldset class="xp-ops-integrations__events" data-ops-int-events disabled><legend>${t('Events')}</legend></fieldset>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-ops-int-add disabled>${t('Add endpoint')}</button><button type="button" class="xp-btn" data-ops-int-save disabled>${t('Save webhooks')}</button></div>
      <p class="xp-help">${t('A signing secret is generated when you save a new endpoint. Rotate a secret by removing and re-adding the endpoint.')}</p>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="int-log" aria-labelledby="ops-int-log">
      <h2 id="ops-int-log">${t('Delivery log')}</h2>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Webhook delivery log')}"><table class="xp-whm-detail-table"><caption class="xp-sr-only">${t('Webhook delivery log')}</caption><thead><tr>${logHeaders.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-ops-int-log><tr><td colspan="5">${t('No deliveries have been recorded.')}</td></tr></tbody></table></div>
    </section>
    ${classicOpsClientTemplates('integrations')}
  </div>`
}
