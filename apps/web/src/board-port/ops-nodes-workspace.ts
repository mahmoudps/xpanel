import { classicOpsClientTemplates } from './ops-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'

/** Linked servers and the configuration cluster for /whm/server/nodes. Host data is filled by the client bindings from authorized reads only. */
export function renderOpsNodesWorkspace(input: { locale: Locale; canRead: boolean; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const headers = [t('Node'), t('Hostname'), t('Role'), t('Version'), t('Enrollment'), t('Actions')]
  const canManage = input.canRead && input.canManage
  const versionHeaders = [t('Version'), t('Created'), t('Sections'), t('Members'), t('Actions')]
  return `<div class="xp-ops-nodes" data-ops-nodes-workspace data-nodes-can-read="${input.canRead}" data-nodes-can-manage="${canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    <style>.xp-ops-nodes{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-ops-nodes :is(h2,h3,p,dl,dd){margin:0}.xp-ops-nodes__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px}.xp-ops-nodes__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-ops-nodes .xp-whm-detail-table th{white-space:nowrap}.xp-ops-nodes__single{padding:16px;border:1px dashed var(--xp-border,#e2e6ec);border-radius:8px}.xp-ops-nodes__choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:8px 16px}.xp-ops-nodes__choices label{display:flex;gap:8px;align-items:center;min-block-size:44px}.xp-ops-nodes__group{display:flex;flex-direction:column;gap:16px;min-inline-size:0}</style>
    <section class="xp-whm-detail-card" data-whm-detail-section="nodes-state" aria-labelledby="ops-nodes-state">
      <h2 id="ops-nodes-state">${t('Managed nodes')}</h2>
      <p class="xp-whm-detail-status" data-ops-nodes-status data-state="${input.canRead ? 'unread' : 'unavailable'}" role="status">${input.canRead ? t('No node registry has been read.') : t('Server nodes require an authorized root administrator. Nothing was read or changed.')}</p>
      <dl class="xp-ops-nodes__facts">
        <div><dt>${t('This server')}</dt><dd><bdi dir="ltr" data-ops-nodes-fact="this">${t('Not read')}</bdi></dd></div>
        <div><dt>${t('Registered nodes')}</dt><dd><bdi dir="ltr" data-ops-nodes-fact="count">${t('Not read')}</bdi></dd></div>
        <div><dt>${t('Channel verification')}</dt><dd><span data-ops-nodes-fact="channel">${t('Not read')}</span></dd></div>
      </dl>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-ops-nodes-action="read"${input.canRead ? '' : ' disabled'}>${t('Read nodes')}</button></div>
      <p class="xp-ops-nodes__single" data-ops-nodes-single hidden>${t('This is the only managed server. Link another server to move accounts to it or push settings to it.')}</p>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="nodes-list" aria-labelledby="ops-nodes-list">
      <h2 id="ops-nodes-list">${t('Nodes')}</h2>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Registered nodes')}"><table class="xp-whm-detail-table"><caption class="xp-sr-only">${t('Registered nodes')}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-ops-nodes-rows><tr><td colspan="6">${t('No node registry has been read.')}</td></tr></tbody></table></div>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="nodes-add" data-ops-nodes-editor aria-labelledby="ops-nodes-add" hidden>
      <h2 id="ops-nodes-add">${t('Link a server')}</h2>
      <div class="xp-ops-nodes__group">
        <h3>${t('On the other server')}</h3>
        <p class="xp-help">${t('Create a link code there. It carries that server\'s address and certificate and one short-lived permission to link.')}</p>
        <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-ops-nodes-action="invite" disabled>${t('Create a link code')}</button></div>
        <div class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><label for="ops-nodes-invite-code">${t('Link code')}</label><input id="ops-nodes-invite-code" data-ops-nodes-invite-code type="text" dir="ltr" readonly disabled></div></div>
        <p class="xp-help" data-ops-nodes-invite-note hidden></p>
      </div>
      <div class="xp-ops-nodes__group">
        <h3>${t('On this server')}</h3>
        <div class="xp-whm-detail-fields">
          <div class="xp-whm-detail-field"><label for="ops-nodes-code">${t('Link code')}</label><input id="ops-nodes-code" data-ops-nodes-code type="text" dir="ltr" autocomplete="off" spellcheck="false" disabled></div>
          <div class="xp-whm-detail-field"><label for="ops-nodes-label">${t('Label')}</label><input id="ops-nodes-label" data-ops-nodes-label type="text" disabled></div>
          <div class="xp-whm-detail-field"><label for="ops-nodes-role">${t('Role')}</label><select id="ops-nodes-role" data-ops-nodes-role disabled><option value="all">${t('All roles')}</option><option value="web">${t('Web')}</option><option value="dns">DNS</option><option value="mail">${t('Mail')}</option><option value="db">${t('Database')}</option></select></div>
        </div>
        <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-ops-nodes-add disabled>${t('Link server')}</button></div>
        <p class="xp-help">${t('Linking pins each server\'s certificate on the other and gives each a credential only the other accepts. Both servers must run the same major version.')}</p>
      </div>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="nodes-cluster" data-node-cluster data-cluster-can-read="${input.canRead}" data-cluster-can-manage="${canManage}" aria-labelledby="ops-nodes-cluster">
      <h2 id="ops-nodes-cluster">${t('Configuration Cluster')}</h2>
      <p class="xp-whm-detail-status" data-node-cluster-status data-state="${input.canRead ? 'unread' : 'unavailable'}" role="status">${input.canRead ? t('The cluster has not been read.') : t('The configuration cluster is unavailable here. Nothing was read or changed.')}</p>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-node-cluster-read${input.canRead ? '' : ' disabled'}>${t('Read cluster')}</button></div>
      <div class="xp-ops-nodes__group">
        <h3>${t('Members')}</h3>
        <div class="xp-ops-nodes__choices" data-node-cluster-members></div>
        <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-node-cluster-save disabled>${t('Save members')}</button></div>
        <p class="xp-help">${t('Only this server knows its members. A server that leaves keeps what it received.')}</p>
      </div>
      <div class="xp-ops-nodes__group">
        <h3>${t('Create a version')}</h3>
        <div class="xp-ops-nodes__choices" data-node-cluster-sections></div>
        <div class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><label for="ops-nodes-cluster-note">${t('Note')}</label><input id="ops-nodes-cluster-note" data-node-cluster-note type="text" maxlength="200" disabled></div></div>
        <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-node-cluster-create disabled>${t('Create version')}</button></div>
      </div>
      <div class="xp-ops-nodes__group">
        <h3>${t('Versions')}</h3>
        <div class="xp-whm-detail-fields">
          <div class="xp-whm-detail-field"><label for="ops-nodes-cluster-member">${t('Member to roll back')}</label><select id="ops-nodes-cluster-member" data-node-cluster-member disabled></select></div>
          <div class="xp-whm-detail-field"><label><input type="checkbox" data-node-cluster-overwrite disabled> ${t('Overwrite local changes on that member')}</label></div>
        </div>
        <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Versions')}"><table class="xp-whm-detail-table"><caption class="xp-sr-only">${t('Versions')}</caption><thead><tr>${versionHeaders.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-node-cluster-versions><tr><td colspan="5">${t('The cluster has not been read.')}</td></tr></tbody></table></div>
      </div>
      <template data-xp-template="node-cluster-choice"><label><input type="checkbox" data-xp-action="select" disabled><span data-xp-slot="name"></span></label></template>
      <template data-xp-template="node-cluster-version-row"><tr><td><bdi dir="ltr" data-xp-slot="number"></bdi></td><td><bdi dir="ltr" data-xp-slot="created"></bdi></td><td><span data-xp-slot="sections"></span></td><td><span data-xp-slot="pushes"></span></td><td><div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-xp-action="push" disabled><span data-xp-slot="push-label"></span></button><button type="button" class="xp-btn" data-xp-action="rollback" disabled><span data-xp-slot="rollback-label"></span></button></div></td></tr></template>
      <template data-xp-template="node-cluster-version-empty"><tr><td colspan="5" data-xp-slot="message"></td></tr></template>
    </section>
    ${classicOpsClientTemplates('nodes')}
  </div>`
}
