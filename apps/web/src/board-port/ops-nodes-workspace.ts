import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'

/** Managed server nodes for /whm/server/nodes. Host data is filled by OPS_NODES_CLIENT_BINDING from authorized reads only. */
export function renderOpsNodesWorkspace(input: { locale: Locale; canRead: boolean; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const headers = [t('Node'), t('Hostname'), t('Role'), t('Enrollment'), t('Actions')]
  return `<div class="xp-ops-nodes" data-ops-nodes-workspace data-nodes-can-read="${input.canRead}" data-nodes-can-manage="${input.canRead && input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    <style>.xp-ops-nodes{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-ops-nodes :is(h2,p,dl,dd){margin:0}.xp-ops-nodes__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px}.xp-ops-nodes__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-ops-nodes .xp-whm-detail-table th{white-space:nowrap}.xp-ops-nodes__single{padding:16px;border:1px dashed var(--xp-border,#e2e6ec);border-radius:8px}</style>
    <section class="xp-whm-detail-card" data-whm-detail-section="nodes-state" aria-labelledby="ops-nodes-state">
      <h2 id="ops-nodes-state">${t('Managed nodes')}</h2>
      <p class="xp-whm-detail-status" data-ops-nodes-status data-state="${input.canRead ? 'unread' : 'unavailable'}" role="status">${input.canRead ? t('No node registry has been read.') : t('Server nodes require an authorized root administrator. Nothing was read or changed.')}</p>
      <dl class="xp-ops-nodes__facts">
        <div><dt>${t('This server')}</dt><dd><bdi dir="ltr" data-ops-nodes-fact="this">${t('Not read')}</bdi></dd></div>
        <div><dt>${t('Registered nodes')}</dt><dd><bdi dir="ltr" data-ops-nodes-fact="count">${t('Not read')}</bdi></dd></div>
        <div><dt>${t('Channel verification')}</dt><dd><span data-ops-nodes-fact="channel">${t('Not read')}</span></dd></div>
      </dl>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-ops-nodes-action="read"${input.canRead ? '' : ' disabled'}>${t('Read nodes')}</button></div>
      <p class="xp-ops-nodes__single" data-ops-nodes-single hidden>${t('This is the only managed server. Register another node to form a multi-server configuration; nodes are only usable once their authenticated channel is verified.')}</p>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="nodes-list" aria-labelledby="ops-nodes-list">
      <h2 id="ops-nodes-list">${t('Nodes')}</h2>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Registered nodes')}"><table class="xp-whm-detail-table"><caption class="xp-sr-only">${t('Registered nodes')}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-ops-nodes-rows><tr><td colspan="5">${t('No node registry has been read.')}</td></tr></tbody></table></div>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="nodes-add" data-ops-nodes-editor aria-labelledby="ops-nodes-add" hidden>
      <h2 id="ops-nodes-add">${t('Register a node')}</h2>
      <div class="xp-whm-detail-fields">
        <div class="xp-whm-detail-field"><label for="ops-nodes-label">${t('Label')}</label><input id="ops-nodes-label" data-ops-nodes-label type="text" disabled></div>
        <div class="xp-whm-detail-field"><label for="ops-nodes-host">${t('Hostname')}</label><input id="ops-nodes-host" data-ops-nodes-host type="text" dir="ltr" placeholder="node2.example.com" disabled></div>
        <div class="xp-whm-detail-field"><label for="ops-nodes-port">${t('Channel port')}</label><input id="ops-nodes-port" data-ops-nodes-port type="number" dir="ltr" value="2087" disabled></div>
        <div class="xp-whm-detail-field"><label for="ops-nodes-fingerprint">${t('Key fingerprint (SHA-256)')}</label><input id="ops-nodes-fingerprint" data-ops-nodes-fingerprint type="text" dir="ltr" disabled></div>
        <div class="xp-whm-detail-field"><label for="ops-nodes-role">${t('Role')}</label><select id="ops-nodes-role" data-ops-nodes-role disabled><option value="all">${t('All roles')}</option><option value="web">${t('Web')}</option><option value="dns">DNS</option><option value="mail">${t('Mail')}</option><option value="db">${t('Database')}</option></select></div>
      </div>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-ops-nodes-add disabled>${t('Add node')}</button><button type="button" class="xp-btn" data-ops-nodes-save disabled>${t('Save registry')}</button></div>
      <p class="xp-help">${t('Registration records the node and its pinned key fingerprint. A node stays pending until its authenticated channel is verified from this server.')}</p>
    </section>
  </div>`
}
