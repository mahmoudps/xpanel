import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'

/** Server NFS shares editor for /whm/server/file-sharing. Host data is filled by OPS_FILE_SHARING_CLIENT_BINDING from authorized reads only. */
export function renderOpsFileSharingWorkspace(input: { locale: Locale; canRead: boolean; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const headers = [t('Path'), t('Clients'), t('Export state'), t('Actions')]
  return `<div class="xp-ops-shares" data-ops-shares-workspace data-shares-can-read="${input.canRead}" data-shares-can-manage="${input.canRead && input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    <style>.xp-ops-shares{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-ops-shares :is(h2,p,dl,dd){margin:0}.xp-ops-shares__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:16px}.xp-ops-shares__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-ops-shares__clients{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-ops-shares__client{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:end}.xp-ops-shares__client>label{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-ops-shares .xp-whm-detail-table th{white-space:nowrap}.xp-ops-shares__foreign{display:flex;flex-wrap:wrap;gap:8px;padding:0;list-style:none}.xp-ops-shares__foreign li{padding:0 8px;line-height:2;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;overflow-wrap:anywhere}</style>
    <section class="xp-whm-detail-card" data-whm-detail-section="shares-state" aria-labelledby="ops-shares-state">
      <h2 id="ops-shares-state">${t('Shared folders')}</h2>
      <p class="xp-whm-detail-status" data-ops-shares-status data-state="${input.canRead ? 'unread' : 'unavailable'}" role="status">${input.canRead ? t('No share configuration has been read.') : t('Server file sharing requires an authorized root administrator. Nothing was read or changed.')}</p>
      <dl class="xp-ops-shares__facts">
        <div><dt>${t('NFS server')}</dt><dd><span data-ops-shares-fact="nfs">${t('Not read')}</span></dd></div>
        <div><dt>${t('Configured shares')}</dt><dd><bdi dir="ltr" data-ops-shares-fact="count">${t('Not read')}</bdi></dd></div>
        <div><dt>${t('Managed exports file')}</dt><dd><span data-ops-shares-fact="managed">${t('Not read')}</span></dd></div>
      </dl>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-ops-shares-action="read"${input.canRead ? '' : ' disabled'}>${t('Read shares')}</button><button type="button" class="xp-btn" data-ops-shares-action="apply" disabled>${t('Apply to active exports')}</button></div>
      <p class="xp-help">${t('Shares are saved as configuration. Applying rewrites the one managed exports file and re-exports with exportfs; active state is read back from the kernel export table. Other NFS exports on this server are never changed.')}</p>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="shares-list" aria-labelledby="ops-shares-list">
      <h2 id="ops-shares-list">${t('Shares')}</h2>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Configured shares')}"><table class="xp-whm-detail-table"><caption class="xp-sr-only">${t('Configured shares')}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-ops-shares-rows><tr><td colspan="4">${t('No share configuration has been read.')}</td></tr></tbody></table></div>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="shares-add" data-ops-shares-editor aria-labelledby="ops-shares-add" hidden>
      <h2 id="ops-shares-add">${t('Add a share')}</h2>
      <div class="xp-whm-detail-fields">
        <div class="xp-whm-detail-field"><label for="ops-shares-path">${t('Folder path')}</label><input id="ops-shares-path" data-ops-shares-path type="text" dir="ltr" placeholder="/srv/shares/example" disabled></div>
        <div class="xp-whm-detail-field"><label for="ops-shares-host">${t('Client host or network')}</label><input id="ops-shares-host" data-ops-shares-host type="text" dir="ltr" placeholder="10.0.0.0/24" disabled></div>
        <div class="xp-whm-detail-field"><label for="ops-shares-permission">${t('Permission')}</label><select id="ops-shares-permission" data-ops-shares-permission disabled><option value="ro">${t('Read only')}</option><option value="rw">${t('Read and write')}</option></select></div>
      </div>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-ops-shares-add disabled>${t('Add share')}</button><button type="button" class="xp-btn" data-ops-shares-save disabled>${t('Save shares')}</button></div>
      <p class="xp-help">${t('New shares default to root squash, subtree check and synchronous writes. Saving stores the configuration; it does not change active exports until you apply.')}</p>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="shares-foreign" data-ops-shares-foreign-card aria-labelledby="ops-shares-foreign" hidden>
      <h2 id="ops-shares-foreign">${t('Other exports on this server')}</h2>
      <p class="xp-help">${t('These directories are exported outside xPanel and are left unchanged.')}</p>
      <ul class="xp-ops-shares__foreign" dir="ltr" data-ops-shares-foreign></ul>
    </section>
  </div>`
}
