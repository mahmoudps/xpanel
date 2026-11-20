// Route-scoped client binding chunks. Each chunk stays within the 60 KB gzip per-route budget
// and is loaded via pageScript() only on pages whose markup carries its binding hooks.

import { pageScript, pageScriptTag, type PageScript } from './page-scripts.ts'
import { ACCOUNT_API_TOKENS_CLIENT_BINDING } from './account-api-tokens-client.ts'
import { ACCOUNT_BACKUP_CLIENT_BINDING } from './account-backup-client.ts'
import { ACCOUNT_COLLABORATION_CLIENT_BINDING } from './account-collaboration-client.ts'
import { ACCOUNT_CONTACT_CLIENT_BINDING } from './account-contact-client.ts'
import { ACCOUNT_CRON_CLIENT_BINDING } from './account-cron-client.ts'
import { ACCOUNT_DATABASE_INSIGHTS_CLIENT_BINDING } from './account-database-insights-client.ts'
import { ACCOUNT_DATABASE_REMOTE_CLIENT_BINDING } from './account-database-remote-client.ts'
import { ACCOUNT_DAV_CLIENT_BINDING } from './account-dav-client.ts'
import { ACCOUNT_DYNAMIC_DNS_CLIENT_BINDING } from './account-dynamic-dns-client.ts'
import { ACCOUNT_EDGE_CLIENT_BINDING } from './account-edge-client.ts'
import { ACCOUNT_FILTERS_CLIENT_BINDING } from './account-filters-client.ts'
import { ACCOUNT_FORWARDERS_CLIENT_BINDING } from './account-forwarders-client.ts'
import { ACCOUNT_FTP_REMOVE_CLIENT_BINDING } from './account-ftp-remove-client.ts'
import { ACCOUNT_GIT_CLIENT_BINDING } from './account-git-client.ts'
import { ACCOUNT_GITWEB_CLIENT_BINDING } from './account-gitweb-client.ts'
import { ACCOUNT_HTACCESS_CLIENT_BINDING } from './account-htaccess-client.ts'
import { ACCOUNT_LEECH_CLIENT_BINDING } from './account-leech-client.ts'
import { ACCOUNT_LOGS_CLIENT_BINDING } from './account-logs-client.ts'
import { ACCOUNT_MAILING_LISTS_CLIENT_BINDING } from './account-mailing-lists-client.ts'
import { ACCOUNT_NETWORK_TOOLS_CLIENT_BINDING } from './account-network-tools-client.ts'
import { ACCOUNT_OWNER_TOOLS_CLIENT_BINDING } from './account-owner-tools-client.ts'
import { ACCOUNT_PASSWORD_CLIENT_BINDING } from './account-password-client.ts'
import { ACCOUNT_PREFLIGHT_CLIENT_BINDING } from './account-preflight-client.ts'
import { PANEL_RESOURCES_CLIENT_BINDING } from './panel-resources-client.ts'
import { ACCOUNT_PGP_CLIENT_BINDING } from './account-pgp-client.ts'
import { ACCOUNT_QUARANTINE_CLIENT_BINDING } from './account-quarantine-client.ts'
import { ACCOUNT_REVERSE_PROXY_CLIENT_BINDING } from './account-reverse-proxy-client.ts'
import { ACCOUNT_RUNTIME_CLIENT_BINDING } from './account-runtime-client.ts'
import { ACCOUNT_SESSIONS_CLIENT_BINDING } from './account-sessions-client.ts'
import { ACCOUNT_SITE_PUBLISHER_CLIENT_BINDING } from './account-site-publisher-client.ts'
import { ACCOUNT_SITE_SETTINGS_CLIENT_BINDING } from './account-site-settings-client.ts'
import { ACCOUNT_SPAM_CLIENT_BINDING } from './account-spam-client.ts'
import { ACCOUNT_SSH_CLIENT_BINDING } from './account-ssh-client.ts'
import { ACCOUNT_SSL_CLIENT_BINDING } from './account-ssl-client.ts'
import { TEAM_AUDIT_CLIENT_BINDING } from './account-team-audit-client.ts'
import { ACCOUNT_VIRUS_SCAN_CLIENT_BINDING } from './account-virus-scan-client.ts'
import { ACCOUNT_WEB_DIRECTIVES_CLIENT_BINDING } from './account-web-directives-client.ts'
import { WEBSITE_BACKUPS_CLIENT_BINDING } from './account-website-backups-client.ts'
import { WHM_BACKUP_RUNS_CLIENT_BINDING } from './acct-backup-runs-client.ts'
import { ACCT_CONVERT_ADDON_CLIENT_BINDING } from './acct-convert-addon-client.ts'
import { WHM_ENHANCEMENTS_CLIENT_BINDING } from './acct-enhancements-client.ts'
import { ACCT_RESTORE_CLIENT_BINDING } from './acct-restore-client.ts'
import { ACCT_STAGING_CLIENT_BINDING } from './acct-staging-client.ts'
import { ACCOUNT_TEAM_CLIENT_BINDING } from './acct-team-client.ts'
import { WHM_ACCOUNT_TEMPLATES_CLIENT_BINDING } from './acct-templates-client.ts'
import { ACCT_TRANSFER_CREDENTIALS_CLIENT_BINDING } from './acct-transfer-credentials-client.ts'
import { BOXTRAPPER_CLIENT_BINDING } from './boxtrapper-client.ts'
import { CTR_CLIENT_BINDING } from './ctr-client.ts'
import { DATABASE_ROW_ACTIONS_CLIENT_BINDING } from './database-row-actions-client.ts'
import { DATABASE_WORKSPACE_CLIENT_BINDING } from './database-workspace-client.ts'
import { DB_ENGINES_CLIENT_BINDING } from './db-engines-client.ts'
import { DB_FTP_CLIENT_BINDINGS } from './db-ftp-client-bindings.ts'
import { DIRECTORY_PRIVACY_CLIENT_BINDING } from './directory-privacy-client.ts'
import { DNSSEC_CLIENT_BINDING } from './dnssec-client.ts'
import { DOMAIN_WORKSPACE_CLIENT_BINDING } from './domain-workspace-client.ts'
import { EMAIL_DISK_USAGE_CLIENT_BINDING } from './email-disk-usage-client.ts'
import { FILE_SHARE_LINKS_CLIENT_BINDING } from './file-share-links-client.ts'
import { FILE_WORKSPACE_CLIENT_BINDING } from './file-workspace-client.ts'
import { HOME_TOOLS_CLIENT_BINDING } from './home-tools-client.ts'
import { IDENTITY_CLIENT_BINDING } from './identity-client.ts'
import { LIST_MODERATION_CLIENT_BINDING } from './list-moderation-client.ts'
import { MAIL_ATTACHMENTS_CLIENT_BINDING } from './mail-attachments-client.ts'
import { MAIL_BULK_CLIENT_BINDING } from './mail-bulk-client.ts'
import { MAIL_CALENDAR_CLIENT_BINDING } from './mail-calendar-client.ts'
import { MAIL_CALENDAR_VIEW_CLIENT_BINDING } from './mail-calendar-view-client.ts'
import { MAIL_CARDS_CLIENT_BINDING } from './mail-cards-client.ts'
import { MAIL_COMPOSE_ATTACHMENTS_CLIENT_BINDING } from './mail-compose-attachments-client.ts'
import { MAIL_COMPOSE_IDENTITIES_CLIENT_BINDING } from './mail-compose-identities-client.ts'
import { MAIL_CONNECT_DEVICES_CLIENT_BINDING } from './mail-connect-devices-client.ts'
import { MAIL_CONTACT_GROUPS_CLIENT_BINDING } from './mail-contact-groups-client.ts'
import { MAIL_CONTACTS_TOOLS_CLIENT_BINDING } from './mail-contacts-tools-client.ts'
import { MAIL_CONTACTS_WORKSPACE_CLIENT_BINDING } from './mail-contacts-workspace-client.ts'
import { MAIL_DISK_USAGE_CLIENT_BINDING } from './mail-disk-usage-client.ts'
import { MAIL_DRAFT_CLIENT_BINDING } from './mail-draft-client.ts'
import { MAIL_FOLDER_WORKSPACE_CLIENT_BINDING } from './mail-folder-workspace-client.ts'
import { MAIL_FOLDERS_CLIENT_BINDING } from './mail-folders-client.ts'
import { MAIL_IDENTITIES_CLIENT_BINDING } from './mail-identities-client.ts'
import { MAIL_MAILBOX_FORWARDERS_CLIENT_BINDING } from './mail-mailbox-forwarders-client.ts'
import { MAIL_MAILBOX_PREFERENCES_CLIENT_BINDING } from './mail-mailbox-preferences-client.ts'
import { MAILBOX_SETTINGS_CLIENT_BINDING } from './mail-mailbox-settings-client.ts'
import { MAIL_MAILING_LISTS_CLIENT_BINDING } from './mail-mailing-lists-client.ts'
import { MAIL_SEARCH_CLIENT_BINDING } from './mail-search-client.ts'
import { MAIL_SEND_CLIENT_BINDING } from './mail-send-client.ts'
import { MAIL_SPAM_CLIENT_BINDING } from './mail-spam-client.ts'
import { MAIL_TOOLS_CLIENT_BINDING } from './mail-tools-client.ts'
import { MAIL_TRACK_DELIVERY_CLIENT_BINDING } from './mail-track-delivery-client.ts'
import { MAIL_VACATION_WORKSPACE_CLIENT_BINDING } from './mail-vacation-workspace-client.ts'
import { MAILING_LIST_ADMIN_CLIENT_BINDING } from './mailing-list-admin-client.ts'
import { MAILX_ARCHIVE_CLIENT_BINDING } from './mailx-archive-client.ts'
import { MAILX_COLLECTIONS_CLIENT_BINDING } from './mailx-collections-client.ts'
import { MAILX_MAIL_TOOLS_CLIENT_BINDING } from './mailx-mail-tools-client.ts'
import { MAILX_WHM_CLIENT_BINDING } from './mailx-whm-client.ts'
import { NODE_CLUSTER_CLIENT_BINDING } from './node-cluster-client.ts'
import { OPS_FILE_SHARING_CLIENT_BINDING } from './ops-file-sharing-client.ts'
import { OPS_INTEGRATIONS_CLIENT_BINDING } from './ops-integrations-client.ts'
import { OPS_NODES_CLIENT_BINDING } from './ops-nodes-client.ts'
import { OPS_TERMINAL_CLIENT_BINDING } from './ops-terminal-client.ts'
import { PANEL_ACCESS_CLIENT_BINDING } from './panel-access-client.ts'
import { PANEL_TOOLS_CLIENT_BINDING } from './panel-tools-client.ts'
import { PERSONAL_PREFERENCES_CLIENT_BINDING } from './personal-preferences-client.ts'
import { SEC_DNS_CLIENT_BINDING } from './sec-dns-client.ts'
import { SEC_SECURITY_CLIENT_BINDING } from './sec-security-client.ts'
import { SERVER_SETTINGS_SUGGEST_CLIENT_BINDING } from './server-settings-suggest-client.ts'
import { SERVICE_USERS_CLIENT_BINDING } from './service-users-client.ts'
import { SIGN_IN_POLICY_CLIENT_BINDING } from './sign-in-policy-client.ts'
import { SITE_HEALTH_CLIENT_BINDING } from './site-health-client.ts'
import { SITE_INSTANCES_CLIENT_BINDING } from './site-software-instances-client.ts'
import { SSL_STORE_CLIENT_BINDING } from './ssl-store-client.ts'
import { SVC_PANELS_CLIENT_BINDING } from './svc-panels-client.ts'
import { SW_ADDON_SERVICES_CLIENT_BINDING } from './sw-addon-services-client.ts'
import { SW_APP_PROJECTS_CLIENT_BINDING } from './sw-app-projects-client.ts'
import { SW_APPLICATIONS_CLIENT_BINDING } from './sw-applications-client.ts'
import { SW_CONTAINERS_CLIENT_BINDING } from './sw-containers-client.ts'
import { SW_DEPLOYMENTS_CLIENT_BINDING } from './sw-deployments-client.ts'
import { SW_OPTIMIZE_CLIENT_BINDING } from './sw-optimize-client.ts'
import { WEB_STATS_CLIENT_BINDING } from './web-stats-client.ts'
import { WHM_ACCOUNT_ADMIN_CLIENT_BINDING } from './whm-account-admin-client.ts'
import { WHM_ACCOUNT_BULK_CLIENT_BINDING } from './whm-account-bulk-client.ts'
import { WHM_ACCOUNT_HEALTH_CLIENT_BINDING } from './whm-account-health-client.ts'
import { WHM_ACCOUNT_REPAIR_CLIENT_BINDING } from './whm-account-repair-client.ts'
import { WHM_ANNOUNCEMENTS_CLIENT_BINDING } from './whm-announcements-client.ts'
import { WHM_BACKUP_DESTINATIONS_CLIENT_BINDING } from './whm-backup-destinations-client.ts'
import { WHM_BACKUP_FILES_CLIENT_BINDING } from './whm-backup-files-client.ts'
import { WHM_BACKUPS_CLIENT_BINDING } from './whm-backups-client.ts'
import { WHM_BENCHMARK_CLIENT_BINDING } from './whm-benchmark-client.ts'
import { WHM_COMPOSER_CLIENT_BINDING } from './whm-composer-client.ts'
import { WHM_CONFIGURATION_HEALTH_CLIENT_BINDING } from './whm-configuration-health-client.ts'
import { WHM_DATABASE_TUNING_CLIENT_BINDING } from './whm-database-tuning-client.ts'
import { WHM_DATABASES_CLIENT_BINDING } from './whm-databases-client.ts'
import { WHM_DEFAULT_INDEX_CLIENT_BINDING } from './whm-default-index-client.ts'
import { WHM_DEFAULT_SITE_CLIENT_BINDING } from './whm-default-site-client.ts'
import { WHM_DEVELOPER_CLIENT_BINDING } from './whm-developer-client.ts'
import { WHM_DNS_CLIENT_BINDING } from './whm-dns-client.ts'
import { WHM_DNS_FILE_CLIENT_BINDING } from './whm-dns-file-client.ts'
import { WHM_DNS_TOOLS_CLIENT_BINDING } from './whm-dns-tools-client.ts'
import { WHM_DOMAIN_BULK_CLIENT_BINDING } from './whm-domain-bulk-client.ts'
import { WHM_DOMAINS_CLIENT_BINDING } from './whm-domains-client.ts'
import { WHM_EXTEND_CLIENT_BINDING } from './whm-extend-client.ts'
import { WHM_FIREWALL_CLIENT_BINDING } from './whm-firewall-client.ts'
import { WHM_FTP_LOG_CLIENT_BINDING } from './whm-ftp-log-client.ts'
import { WHM_HOST_TOOLS_CLIENT_BINDING } from './whm-host-tools-client.ts'
import { WHM_IPS_CLIENT_BINDING } from './whm-ips-client.ts'
import { WHM_JOBS_CLIENT_BINDING } from './whm-jobs-client.ts'
import { WHM_LANGUAGES_CLIENT_BINDING } from './whm-languages-client.ts'
import { WHM_LOCAL_ARCHIVES_CLIENT_BINDING } from './whm-local-archives-client.ts'
import { WHM_LOG_TOOLS_CLIENT_BINDING } from './whm-log-tools-client.ts'
import { WHM_MAIL_LOG_CLIENT_BINDING } from './whm-mail-log-client.ts'
import { WHM_MAIL_QUALITY_CLIENT_BINDING } from './whm-mail-quality-client.ts'
import { WHM_MAIL_QUEUE_CLIENT_BINDING } from './whm-mail-queue-client.ts'
import { WHM_MAIL_SERVER_CLIENT_BINDING } from './whm-mail-server-client.ts'
import { WHM_MAILBOX_MAINTENANCE_CLIENT_BINDING } from './whm-mailbox-maintenance-client.ts'
import { WHM_METERING_CLIENT_BINDING } from './whm-metering-client.ts'
import { WHM_MONITORING_ALERTS_CLIENT_BINDING } from './whm-monitoring-alerts-client.ts'
import { WHM_MONITORING_CLIENT_BINDING } from './whm-monitoring-client.ts'
import { WHM_NETWORK_CLIENT_BINDING } from './whm-network-client.ts'
import { WHM_NGINX_PROXY_CLIENT_BINDING } from './whm-nginx-proxy-client.ts'
import { WHM_PANEL_BRANDING_CLIENT_BINDING } from './whm-panel-branding-client.ts'
import { WHM_PANEL_DATA_CLIENT_BINDING } from './whm-panel-data-client.ts'
import { WHM_PANEL_NOTIFICATIONS_CLIENT_BINDING } from './whm-panel-notifications-client.ts'
import { WHM_PANEL_SETTINGS_CLIENT_BINDING } from './whm-panel-settings-client.ts'
import { WHM_PANEL_TOKENS_CLIENT_BINDING } from './whm-panel-tokens-client.ts'
import { WHM_PHP_CLIENT_BINDING } from './whm-php-client.ts'
import { WHM_PREFERENCES_CLIENT_BINDING } from './whm-preferences-client.ts'
import { WHM_REPAIR_CLIENT_BINDING } from './whm-repair-client.ts'
import { WHM_RESELLER_SUSPEND_CLIENT_BINDING } from './whm-reseller-suspend-client.ts'
import { WHM_SECURITY_CLIENT_BINDING } from './whm-security-client.ts'
import { WHM_SECURITY_TOOLS_CLIENT_BINDING } from './whm-security-tools-client.ts'
import { WHM_SERVER_HEALTH_CLIENT_BINDING } from './whm-server-health-client.ts'
import { WHM_SERVER_INFO_CLIENT_BINDING } from './whm-server-info-client.ts'
import { WHM_SERVER_OBSERVATION_CLIENT_BINDING } from './whm-server-observation-client.ts'
import { WHM_SERVER_OPS_CLIENT_BINDING } from './whm-server-ops-client.ts'
import { WHM_SERVICE_DETAIL_CLIENT_BINDING } from './whm-service-detail-client.ts'
import { WHM_SERVICE_MANAGER_CLIENT_BINDING } from './whm-service-manager-client.ts'
import { WHM_SOFTWARE_CENTER_CLIENT_BINDING } from './whm-software-center-client.ts'
import { WHM_SSH_CLIENT_BINDING } from './whm-ssh-client.ts'
import { WHM_SSH_POLICY_CLIENT_BINDING } from './whm-ssh-policy-client.ts'
import { WHM_SSL_CLIENT_BINDING } from './whm-ssl-client.ts'
import { WHM_SSL_INSTALL_CLIENT_BINDING } from './whm-ssl-install-client.ts'
import { WHM_SUPPORT_CLIENT_BINDING } from './whm-support-client.ts'
import { WHM_TRAFFIC_CLIENT_BINDING } from './whm-traffic-client.ts'
import { WHM_TRANSFER_CLIENT_BINDING } from './whm-transfer-client.ts'
import { WHM_TRUSTED_PROXIES_CLIENT_BINDING } from './whm-trusted-proxies-client.ts'
import { WHM_TWEAK_SETTINGS_CLIENT_BINDING } from './whm-tweak-settings-client.ts'
import { WHM_UPDATES_CLIENT_BINDING } from './whm-updates-client.ts'
import { WHM_UPGRADE_CLIENT_BINDING } from './whm-upgrade-client.ts'
import { WHM_WEB_DIRECTIVES_CLIENT_BINDING } from './whm-web-directives-client.ts'
import { WHM_WEB_SERVER_CLIENT_BINDING } from './whm-web-server-client.ts'
import { WHM_WHMCS_CLIENT_BINDING } from './whm-whmcs-client.ts'
import { ZONE_EDITOR_CLIENT_BINDING } from './zone-editor-client.ts'

export interface RouteClientChunk {
  readonly id: string
  readonly surface: 'xwhm' | 'xpanel' | 'xmail' | 'any'
  readonly hooks: readonly string[]
  readonly alwaysForSurface: boolean
  readonly script: PageScript
}

const chunk = (
  id: string,
  surface: 'xwhm' | 'xpanel' | 'xmail' | 'any',
  hooks: readonly string[],
  alwaysForSurface: boolean,
  body: string,
): RouteClientChunk => Object.freeze({
  id,
  surface,
  hooks: Object.freeze([...hooks]),
  alwaysForSurface,
  script: pageScript(`chunk-${id}`, body),
})

export const ROUTE_CLIENT_CHUNKS: readonly RouteClientChunk[] = Object.freeze([
  chunk('panel-email-1', 'any', ["data-forwarder-refresh","data-forwarder-workspace","data-forwarder-rows","data-forwarder-empty","data-forwarder-create","data-forwarder-can-read","data-forwarder-manage","data-forwarder-destination-field","data-filter-workspace","data-filter-can-read","data-filter-manage","data-read-only","data-filter-scope","data-filter-editor","data-filter-status","data-filter-list","data-mailing-lists","data-mailing-lists-rows","data-mailing-list-status","data-ml-name","data-ml-domain","data-ml-members","data-ml-moderation","data-ml-archive","data-spam-settings","data-spam-settings-can-read","data-spam-can-manage","data-spam-status","data-spam-save","data-spam-enabled","data-spam-box","data-spam-autodelete","data-account-quarantine","data-quarantine-mailbox","data-quarantine-status","data-quarantine-messages","data-quarantine-detail","data-quarantine-","data-quarantine-headers","data-list-admin-status","data-list-","data-list-password","data-list-password-list","data-list-password-input","data-list-password-save","data-list-admin","data-moderation-rows","data-moderation-approve","data-moderation-reject","data-moderation-discard","data-moderation-reason","data-moderation-message","data-moderation-held","data-moderation-status","data-boxtrapper","data-boxtrapper-status","data-boxtrapper-mailbox","data-boxtrapper-enabled","data-boxtrapper-name","data-boxtrapper-days","data-boxtrapper-score","data-boxtrapper-auto-sent","data-autoresponder-workspace","data-default-workspace"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${ACCOUNT_FORWARDERS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_FILTERS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_MAILING_LISTS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_SPAM_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_QUARANTINE_CLIENT_BINDING})(askDialog);
    (${MAILING_LIST_ADMIN_CLIENT_BINDING})();
    (${LIST_MODERATION_CLIENT_BINDING})(askDialog);
    (${BOXTRAPPER_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('panel-email-2', 'any', ["data-email-disk-usage","data-email-usage-","data-email-usage-sort","data-read-only","data-account-web-disk","data-web-disk-status","data-web-disk-rows","data-web-disk-addresses","data-web-disk-unsecured","data-web-disk-form-title","data-web-disk-refresh","data-account-pgp","data-pgp-rows","data-pgp-status","data-pgp-refresh","data-pgp-generate","data-pgp-import","data-pgp-delete","data-pgp-name","data-dav-connection"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${EMAIL_DISK_USAGE_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_DAV_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_PGP_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('panel-security-1', 'any', ["data-account-sessions","data-sessions-rows","data-sessions-status","data-sessions-revoke-others","data-read-only","data-sessions-can-read","data-sessions-can-revoke","data-sessions-count","data-account-password","data-account-password-form","data-account-password-status","data-account-password-submit","data-account-password-show","data-auth-readonly","data-impersonation","data-account-api-tokens","data-account-tokens-","data-account-tokens-secret","data-account-tokens-reveal","data-account-tokens-status","data-account-tokens-scope","data-account-tokens-count","data-account-ssl","data-account-ssl-","data-ssl-store","data-ssl-store-can-read","data-ssl-store-can-manage","data-ssl-store-account","data-ssl-store-status","data-ssl-store-keys","data-ssl-store-csrs","data-ssl-store-certificates","data-account-ssh","data-ssh-","data-account-virus-scan","data-vscan-","data-vscan-kpi","data-sec-status","data-sec-result","data-sec-field","data-sec-input","data-sec-rows","data-sec-workspace","data-sec-action"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${ACCOUNT_SESSIONS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_PASSWORD_CLIENT_BINDING})();
    (${ACCOUNT_API_TOKENS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_SSL_CLIENT_BINDING})(askDialog);
    (${SSL_STORE_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_SSH_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_VIRUS_SCAN_CLIENT_BINDING})(askDialog);
    (${SEC_SECURITY_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('panel-security-2', 'any', ["data-panel-access","data-sec-action","data-sec-input","data-sec-workspace","data-sec-zone-truncated","data-identity-totp","data-read-only","data-leech-protection","data-lp-folder","data-lp-max","data-lp-url","data-lp-email","data-lp-disable","data-lp-save"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${PANEL_ACCESS_CLIENT_BINDING})(askDialog);
    (${SEC_DNS_CLIENT_BINDING})(askDialog);
    (${IDENTITY_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_LEECH_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('panel-prefs-1', 'any', ["data-account-contact","data-contact-form","data-contact-status","data-contact-saved","data-contact-refresh","data-contact-reload","data-contact-save","data-acct-team-workspace","data-acct-team-status","data-acct-team-loading","data-acct-team-rows","data-acct-team-empty","data-acct-team-usage","data-acct-team-refresh","data-acct-team-list-status","data-panel-home","data-home-filter","data-tool-section","data-tool-empty","data-tool-group","data-tool","data-home-accordion","data-group-count","data-account-collaboration","data-collaboration-mailbox","data-collaboration-name","data-collaboration-color","data-collaboration-timezone","data-collaboration-create","data-collaboration-refresh","data-collaboration-status","data-read-only","data-metrics-export","data-metrics-status","data-metrics-enabled","data-metrics-allow","data-metrics-save","data-metrics-refresh","data-metrics-fact","data-personal-preferences","data-personal-status","data-personal-save","data-personal-locale","data-personal-position","data-personal-notify","data-onboarding","data-onboarding-dismiss","data-team-audit","data-team-audit-rows","data-team-audit-status","data-team-audit-search","data-team-audit-read","data-team-audit-more","data-server-information","data-server-info-status","data-server-info","data-server-services","data-server-info-read","data-perl-modules","data-perl-install","data-perl-module","data-service-users","data-service-user-","data-service-users-rows","data-service-users-status","data-terminal-emulator","data-terminal-workspace","data-terminal-status","data-terminal-pill","data-terminal-exec-pill","data-terminal-reauth","data-terminal-password","data-terminal-totp-field","data-html-editor","data-image-tools","data-site-compression","data-account-packages","data-api-shell","data-config-code","data-error-reporting","data-panel-backups","data-plugin-import","data-python-runtimes","data-sw-projects-manager"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${ACCOUNT_CONTACT_CLIENT_BINDING})(askDialog, rtl);
    (${ACCOUNT_TEAM_CLIENT_BINDING})(askDialog, rtl);
    (${HOME_TOOLS_CLIENT_BINDING})();
    (${ACCOUNT_COLLABORATION_CLIENT_BINDING})(askDialog);
    (${PANEL_TOOLS_CLIENT_BINDING})(askDialog);
    (${PERSONAL_PREFERENCES_CLIENT_BINDING})();
    (${TEAM_AUDIT_CLIENT_BINDING})();
    (${ACCOUNT_OWNER_TOOLS_CLIENT_BINDING})(askDialog);
    (${SERVICE_USERS_CLIENT_BINDING})(askDialog);
    (${OPS_TERMINAL_CLIENT_BINDING})();
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('panel-prefs-2', 'any', ["data-ops-nodes-workspace","data-ops-nodes-status","data-ops-nodes-rows","data-ops-nodes-editor","data-ops-nodes-single","data-ops-nodes-","data-ops-nodes-action","data-ops-nodes-add","data-node-cluster","data-node-cluster-status","data-node-cluster-members","data-node-cluster-sections","data-node-cluster-versions","data-node-cluster-note","data-node-cluster-member","data-node-cluster-overwrite","data-ops-integrations-workspace","data-ops-int-status","data-ops-int-rows","data-ops-int-log","data-ops-int-editor","data-ops-int-url","data-ops-int-events","data-ops-int-add"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${OPS_NODES_CLIENT_BINDING})(askDialog);
    (${NODE_CLUSTER_CLIENT_BINDING})(askDialog);
    (${OPS_INTEGRATIONS_CLIENT_BINDING})();
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('panel-files-1', 'any', ["data-account-backup","data-account-backup-status","data-account-backup-select","data-account-backup-archives","data-account-backup-differences","data-account-backup-confirmation","data-account-backup-ack","data-account-backup-download","data-directory-privacy","data-directory-privacy-rows","data-directory-privacy-status","data-directory-privacy-preview","data-directory-privacy-preview-wrap","data-directory-privacy-path","data-directory-privacy-prompt","data-directory-privacy-username","data-file-manager","data-file-select-all","data-file-filter","data-file-manager-table","data-file-selection-count","data-file-selection-clear","data-file-detail","data-file-permission-bit","data-website-backups","data-website-domain","data-website-rows","data-website-status","data-website-create","data-website-databases","data-website-mode","data-website-fit","data-account-git","data-git-can-read","data-git-manage","data-git-","data-file-share-links","data-file-share-","data-account-gitweb","data-gitweb-","data-git-repository","data-gitweb-panel","data-gitweb-fact","data-file-selection-action"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${ACCOUNT_BACKUP_CLIENT_BINDING})(askDialog);
    (${DIRECTORY_PRIVACY_CLIENT_BINDING})(askDialog);
    (${FILE_WORKSPACE_CLIENT_BINDING})(askDialog);
    (${WEBSITE_BACKUPS_CLIENT_BINDING})();
    (${ACCOUNT_GIT_CLIENT_BINDING})(askDialog);
    (${FILE_SHARE_LINKS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_GITWEB_CLIENT_BINDING})();
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('panel-files-2', 'any', ["data-ops-shares-workspace","data-ops-shares-status","data-ops-shares-rows","data-ops-shares-editor","data-ops-shares-foreign-card","data-ops-shares-foreign","data-ops-shares-path","data-ops-shares-host","data-ftp-create","data-ftp-create-submit","data-ftp-remove-status","data-ftp-remove"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${OPS_FILE_SHARING_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_FTP_REMOVE_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('panel-software-1', 'any', ["data-account-cron","data-read-only","data-cron-status","data-cron-jobs","data-cron-preset","data-cron-unlimited","data-cron-enabled","data-cron-field","data-account-raw-access","data-raw-access-form","data-raw-access-save","data-raw-access","data-raw-access-source","data-raw-access-status","data-raw-access-rows","data-raw-access-list-status","data-account-network-tools","data-nettools-","data-nettools-field","data-htaccess-workspace","data-htaccess-domain","data-htaccess-editor","data-htaccess-status","data-htaccess-versions","data-htaccess-issues","data-htaccess-","data-sw-status","data-sw-refresh","data-sw-engine-state","data-human","data-sw-observed","data-sw-containers","data-sw-filter-engine","data-ctr-workspace","data-ctr-field","data-ctr-rows","data-ctr-do","data-sw-addons","data-sw-addons-status","data-sw-addons-refresh","data-sw-addons-rows","data-sw-addons-job","data-sw-addons-job-link","data-cron-kpi","data-account-logs","data-sw-container-engine"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${ACCOUNT_CRON_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_LOGS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_NETWORK_TOOLS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_HTACCESS_CLIENT_BINDING})(askDialog);
    (${SW_CONTAINERS_CLIENT_BINDING})(askDialog);
    (${CTR_CLIENT_BINDING})(askDialog);
    (${SW_ADDON_SERVICES_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('panel-software-2', 'any', ["data-read-only","data-sw-deployments","data-sw-dep-","data-human","data-sw-projects","data-sw-projects-status","data-sw-projects-refresh","data-sw-projects-runtimes","data-sw-optimize","data-sw-optimize-status","data-sw-optimize-refresh","data-sw-optimize-domains","data-sw-optimize-types","data-sw-optimize-","data-sw-apps","data-sw-apps-status","data-sw-apps-refresh","data-sw-apps-domain-select","data-sw-apps-path-input","data-sw-apps-instances","data-sw-apps-instance-select","data-sw-apps-app-select","data-site-instances","data-site-instances-status","data-site-instances-rows","data-site-instances-releases","data-site-instances-select","data-site-instances-release-select","data-site-instances-file","data-site-instances-action","data-runtime-workspace","data-runtime-status","data-runtime-refresh","data-runtime-log","data-runtime-input","data-runtime-action","data-runtime-can-read","data-runtime-can-manage"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${SW_DEPLOYMENTS_CLIENT_BINDING})(askDialog);
    (${SW_APP_PROJECTS_CLIENT_BINDING})();
    (${SW_OPTIMIZE_CLIENT_BINDING})();
    (${SW_APPLICATIONS_CLIENT_BINDING})(askDialog);
    (${SITE_INSTANCES_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_RUNTIME_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-accounts-1', 'any', ["data-account-staging","data-staging-","data-read-only","data-accounts-workspace","data-approved-account-bulk","data-account-select-all","data-account-selected-count","data-account-bulk-status","data-account-bulk-results","data-account-bulk-plan-choice","data-account-bulk-owner-choice","data-whm-health-workspace","data-whm-health-","data-whm-health-pick","data-whm-health-account","data-whm-health-empty","data-whm-restore-more-workspace","data-restore-more-","data-file","data-acct-transfer-credentials","data-acct-transfer-credentials-status","data-acct-transfer-credentials-rows","data-acct-transfer-credentials-loading","data-acct-transfer-credentials-empty","data-acct-transfer-credential-input","data-acct-transfer-credential-save","data-acct-transfer-credentials-refresh","data-acct-convert-addon","data-acct-convert-status","data-acct-convert-review-status","data-acct-convert-capability","data-acct-convert-input","data-acct-convert-preview","data-acct-convert-apply","data-acct-convert-refresh","data-acct-templates-workspace","data-acct-templates-status","data-acct-templates-loading","data-acct-templates-rows","data-acct-templates-empty","data-acct-templates-refresh","data-acct-templates-list-status","data-acct-templates-plans","data-whm-account-repair","data-account-repair-","data-reseller-suspend","data-reseller-suspend-status"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${ACCT_STAGING_CLIENT_BINDING})(askDialog);
    (${WHM_ACCOUNT_BULK_CLIENT_BINDING})(askDialog);
    (${WHM_ACCOUNT_HEALTH_CLIENT_BINDING})();
    (${ACCT_RESTORE_CLIENT_BINDING})();
    (${ACCT_TRANSFER_CREDENTIALS_CLIENT_BINDING})(askDialog);
    (${ACCT_CONVERT_ADDON_CLIENT_BINDING})(askDialog);
    (${WHM_ACCOUNT_TEMPLATES_CLIENT_BINDING})(askDialog, rtl);
    (${WHM_ACCOUNT_REPAIR_CLIENT_BINDING})(askDialog);
    (${WHM_RESELLER_SUSPEND_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-accounts-2', 'any', ["data-read-only","data-whm-force-password","data-force-password-status","data-force-password-rows","data-force-password-save","data-force-password-all","data-force-password-none","data-whm-shell-access","data-whm-account-enhancements","data-whm-email-users","data-whm-locale-copy","data-whm-rearrange","data-whm-skeleton","data-whm-web-templates"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_ACCOUNT_ADMIN_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('panel-domains-1', 'any', ["data-web-directives","data-wd-domain","data-wd-status","data-wd-rows","data-wd-notice","data-wd-issues","data-wd-","data-wd-field","data-site-health","data-read-only","data-health-","data-domain-workspace","data-domain-create","data-domain-settings-form","data-domain-status","data-domain-","data-domain-parent-field","data-domain-alias-help","data-domain-root-help","data-reverse-proxy","data-rp-","data-rp-header","data-rp-header-empty","data-rp-header-field","data-site-settings","data-site-can-read","data-site-manage","data-site-","data-site-selector","data-site-deny-name","data-site-deny-directory","data-site-deny-extensions","data-dns-editor","data-whm-dns-workspace","data-dns-zone","data-dns-account","data-dns-new-name","data-dns-records","data-dns-status","data-dns-add-record"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${ACCOUNT_WEB_DIRECTIVES_CLIENT_BINDING})(askDialog);
    (${SITE_HEALTH_CLIENT_BINDING})(askDialog);
    (${DOMAIN_WORKSPACE_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_REVERSE_PROXY_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_SITE_SETTINGS_CLIENT_BINDING})(askDialog);
    (${ZONE_EDITOR_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('panel-domains-2', 'any', ["data-dnssec","data-dnssec-zone","data-dnssec-status","data-dnssec-keys","data-dnssec-rollovers","data-dnssec-ds","data-dnssec-algorithm","data-dnssec-layout","data-web-stats-metrics","data-web-stats-metrics-save","data-web-stats-metrics-status","data-web-stats-choice","data-web-stats-engines","data-web-stats-policy","data-web-stats-save","data-web-stats-process","data-read-only","data-ip-blocker","data-ipb-input","data-ipb-add","data-ipb-refresh","data-ipb-status","data-ipb-rows","data-ipb-error","data-account-dynamic-dns","data-ddns-","data-account-site-publisher","data-sitepub-can-read","data-sitepub-manage","data-sitepub-","data-edge-cache","data-web-stats-locks"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${DNSSEC_CLIENT_BINDING})(askDialog);
    (${WEB_STATS_CLIENT_BINDING})();
    (${ACCOUNT_EDGE_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_DYNAMIC_DNS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_SITE_PUBLISHER_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('panel-databases', 'xpanel', ["data-account-database-insights","data-read-only","data-insights-read","data-insights-database","data-insights-status","data-insights-databases","data-insights-tables","data-insights-users","data-database-workspace","data-db-create","data-dbu-create","data-db-grant-form","data-db-status","data-db-rows","data-dbu-rows","data-account-database-remote","data-remote-","data-db-row-status","data-db-copy-details","data-db-connection","data-db-reset-user","data-db-reset-password","data-db-reset-save","data-db-row-action"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${ACCOUNT_DATABASE_INSIGHTS_CLIENT_BINDING})(askDialog);
    (${DATABASE_WORKSPACE_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_DATABASE_REMOTE_CLIENT_BINDING})(askDialog);
    (${DATABASE_ROW_ACTIONS_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('mail-core', 'xmail', ["data-mail-folder-workspace","data-mail-list","data-mail-article","data-mail-folder-status","data-mail-folder-row-template","data-mail-folder-reading-template","data-mail-pager","data-mail-open","data-mail-folders","data-mail-folders-status","data-mail-folders-rows","data-mail-folders-create","data-mail-folders-editor","data-folders-can-read","data-folders-can-manage","data-mail-folders-fact","data-compose-identities","data-compose-identities-status","data-compose-identities-refresh","data-compose-signature-insert","data-mail-send","data-compose-identities-can-read","data-compose-identities-manage","data-compose-attachments","data-compose-form","data-compose-attachment-open","data-compose-attachment-input","data-compose-attachment-list","data-compose-attachment-status","data-compose-attachment-summary","data-mail-action","data-mail-draft-status","data-read-only","data-mail-chip","data-mail-bulk","data-mail-bulk-status","data-mail-bulk-action","data-mail-attachments","data-attachment-status","data-attachment-list","data-attachment-refresh","data-attachment-heading","data-uid-validity","data-attachment-can-read","data-mail-search-workspace","data-mail-search-message","data-mail-pane=\"reading-pane\"","data-compose-identity-label","data-compose-reply-to","data-mail-from-addr"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${MAIL_FOLDER_WORKSPACE_CLIENT_BINDING})(askDialog, rtl);
    (${MAIL_FOLDERS_CLIENT_BINDING})();
    (${MAIL_COMPOSE_IDENTITIES_CLIENT_BINDING})(askDialog);
    (${MAIL_COMPOSE_ATTACHMENTS_CLIENT_BINDING})(askDialog);
    (${MAIL_DRAFT_CLIENT_BINDING})();
    ${MAIL_SEND_CLIENT_BINDING}
    (${MAIL_BULK_CLIENT_BINDING})(askDialog);
    var bindMailAttachments = (${MAIL_ATTACHMENTS_CLIENT_BINDING});
    bindMailAttachments(askDialog);
    if (document.documentElement.dataset.mailSearchAttachmentsBound !== 'true') {
      document.documentElement.dataset.mailSearchAttachmentsBound = 'true';
      function applyMailAttachmentSelection(article, selection) {
        if (typeof selection.mailbox !== 'string' || !selection.mailbox
          || typeof selection.folder !== 'string' || selection.folder !== selection.folder.trim() || !/^[A-Za-z][A-Za-z0-9._-]{0,40}$/.test(selection.folder)
          || !Number.isInteger(selection.uid) || selection.uid < 1 || selection.uid > 4294967295
          || !Number.isInteger(selection.uidValidity) || selection.uidValidity < 1 || selection.uidValidity > 4294967295) return;
        var matched = false;
        article.querySelectorAll('[data-mail-attachments]').forEach(function (root) {
          if (root.closest('[data-mail-search-message],[data-mail-article="true"]') !== article || root.getAttribute('data-mailbox') !== selection.mailbox) return;
          matched = true;
          [['data-folder', selection.folder], ['data-uid', String(selection.uid)], ['data-uid-validity', String(selection.uidValidity)]].forEach(function (attribute) {
            if (root.getAttribute(attribute[0]) !== attribute[1]) root.setAttribute(attribute[0], attribute[1]);
          });
        });
        if (matched) bindMailAttachments(askDialog);
      }
      document.addEventListener('xpanel:mail-search-selection', function (event) {
        var selection = event.detail, article = event.target;
        if (!(article instanceof Element) || !article.matches('[data-mail-search-message]') || !article.isConnected || !selection || typeof selection !== 'object') return;
        var workspace = article.closest('[data-mail-search-workspace]');
        if (!workspace || workspace.getAttribute('data-search-mailbox') !== selection.mailbox || workspace.getAttribute('data-search-enabled') !== 'true') return;
        applyMailAttachmentSelection(article, selection);
      });
      document.addEventListener('xpanel:mail-message-read', function (event) {
        var selection = event.detail, article = event.target;
        if (!(article instanceof Element) || !article.matches('[data-mail-pane="reading-pane"][data-mail-article="true"]') || !article.isConnected || !selection || typeof selection !== 'object' || selection.uidValidityObserved !== true) return;
        var workspace = article.closest('[data-board-port="xmail-inbox"][data-product="true"]');
        if (!workspace || workspace.getAttribute('data-mailbox') !== selection.mailbox || workspace.getAttribute('data-mail-folder') !== selection.folder
          || workspace.querySelector('[data-mail-pane="reading-pane"][data-mail-article="true"]') !== article) return;
        applyMailAttachmentSelection(article, selection);
      });
    }
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('mail-organizer', 'xmail', ["data-mail-contacts","data-contacts-can-read","data-contact-manage","data-contact-form","data-contact-","data-contact-rows","data-contact-status","data-contact-search","data-mail-contact-groups","data-groups-can-read","data-groups-manage","data-groups-","data-mail-contacts-tools","data-contacts-import-file","data-contacts-import-text","data-contacts-import-preview","data-contacts-import-status","data-contacts-import","data-contacts-export","data-contacts-export-status","data-mail-calendar","data-calendar-can-read","data-calendar-manage","data-calendar-","data-calendar-select","data-calendar-event-select","data-calendar-share-permission","data-calendar-ics","data-mail-calendar-view","data-read-only","data-calview-","data-calview-field","data-calview-day","data-calview-item"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${MAIL_CONTACTS_WORKSPACE_CLIENT_BINDING})(askDialog);
    (${MAIL_CONTACT_GROUPS_CLIENT_BINDING})(askDialog);
    (${MAIL_CONTACTS_TOOLS_CLIENT_BINDING})(askDialog);
    (${MAIL_CALENDAR_CLIENT_BINDING})(askDialog);
    (${MAIL_CALENDAR_VIEW_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('mail-tools-1', 'any', ["data-mail-identities","data-identities-can-read","data-identities-manage","data-identities-rows","data-identities-status","data-identities-form-title","data-identities-display-name","data-identities-reply-to","data-mail-vacation","data-vacation-status","data-vacation-can-read","data-vacation-manage","data-vacation-form","data-vacation-","data-vacation-panel","data-vacation-requested","data-mail-search-workspace","data-mail-search-form","data-mail-search-query","data-mail-search-folder","data-mail-search-results","data-mail-search-status","data-mail-search-message","data-mail-search-submit","data-read-only","data-mail-track-delivery","data-mail-track-form","data-mail-track-status","data-mail-track-rows","data-mail-track-detail","data-mail-track-fact","data-mail-track-detail-facts","data-mail-disk-usage","data-mail-usage-status","data-mail-usage-rows","data-mail-usage-cleanup","data-mail-usage-preview","data-mail-usage-apply","data-usage-can-read","data-usage-can-manage","data-mail-connect-devices","data-mail-devices-status","data-mail-devices-rows","data-mail-devices-download-note","data-mail-devices-download","data-mail-devices-send-form","data-mail-devices-send-email","data-mail-forwarders","data-forwarders-status","data-forwarders-rows","data-forwarders-count","data-forwarders-add","data-forwarders-refresh","data-forwarders-can-read","data-forwarders-can-manage","data-mail-preferences","data-preferences-status","data-preferences-record","data-preferences-plus","data-preferences-save","data-preferences-discard","data-preferences-refresh","data-mail-preferences-can-read","data-mail-tools-quota","data-tools-used","data-tools-limit","data-tools-observed","data-tools-status","data-tools-refresh","data-mail-spam","data-spam-can-read","data-spam-manage","data-spam-status","data-spam-policy","data-spam-effective","data-spam-saved","data-spam-save"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${MAIL_IDENTITIES_CLIENT_BINDING})(askDialog);
    (${MAIL_VACATION_WORKSPACE_CLIENT_BINDING})(askDialog);
    (${MAIL_SEARCH_CLIENT_BINDING})(askDialog);
    (${MAIL_TRACK_DELIVERY_CLIENT_BINDING})();
    (${MAIL_DISK_USAGE_CLIENT_BINDING})();
    (${MAIL_CONNECT_DEVICES_CLIENT_BINDING})();
    (${MAIL_MAILBOX_FORWARDERS_CLIENT_BINDING})(askDialog);
    (${MAIL_MAILBOX_PREFERENCES_CLIENT_BINDING})(askDialog);
    (${MAIL_TOOLS_CLIENT_BINDING})(askDialog);
    (${MAIL_SPAM_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('mail-tools-2', 'any', ["data-mail-mailing-lists","data-lists-status","data-lists-rows","data-lists-refresh","data-read-only","data-list-action","data-mailbox-settings","data-mailbox-settings-status","data-mailbox-settings-save","data-mailbox-settings-addresses","data-mailbox-settings-alerts","data-mailbox-settings-ranges","data-mailbox-settings-plus","data-mailbox-settings-warning","data-mail-card","data-mail-card-status","data-mail-card-field","data-mail-card-action","data-mail-card-fact","data-mail-card-write","data-mail-card-rows","data-compose-form"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${MAIL_MAILING_LISTS_CLIENT_BINDING})(askDialog);
    (${MAILBOX_SETTINGS_CLIENT_BINDING})();
    (${MAIL_CARDS_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-network-1', 'any', ["data-whm-dns-workspace","data-dns-editor","data-dns-zone","data-dns-account","data-dns-new-name","data-dns-records","data-dns-status","data-dns-","data-whm-domains-workspace","data-whm-domain-account","data-whm-domain-selected","data-whm-domain-create","data-whm-domain-settings","data-whm-domain-status","data-whm-domain-details","data-whm-domain-facts","data-default-site-workspace","data-default-site-form","data-default-site-response","data-default-site-redirect","data-default-site-refuse-https","data-default-site-save","data-default-site-discard","data-default-site-refresh","data-domain-bulk","data-whm-table-workspace","data-domain-bulk-action","data-domain-bulk-value","data-domain-bulk-run","data-domain-bulk-status","data-domain-bulk-results","data-domain-bulk-count","data-whm-dns-tools-workspace","data-whm-dns-tools-refresh","data-whm-dns-tools-ttl","data-whm-dns-tools-search","data-whm-dns-tools-job-link","data-whm-dns-tools-selected","data-read-only","data-whm-dns-tools-status","data-default-index-workspace","data-default-index-domain","data-default-index-files","data-default-index-refresh","data-default-index-preview","data-default-index-save","data-default-index-reset","data-default-index-status","data-nginx-proxy","data-np-domain","data-np-path","data-np-target","data-np-host","data-np-websocket","data-np-add","data-np-refresh","data-dns-file","data-dns-file-input","data-dns-file-text","data-dns-file-rows","data-dns-file-status","data-dns-file-export","data-whm-ip-pool","data-add-ip-form","data-ip-pool-table","data-add-ip-status","data-ip-pool-status","data-ip-pool-count-label","data-ip-remove"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_DNS_CLIENT_BINDING})(askDialog);
    (${WHM_DOMAINS_CLIENT_BINDING})(askDialog);
    (${WHM_DEFAULT_SITE_CLIENT_BINDING})(askDialog);
    (${WHM_DOMAIN_BULK_CLIENT_BINDING})(askDialog);
    (${WHM_DNS_TOOLS_CLIENT_BINDING})(askDialog);
    (${WHM_DEFAULT_INDEX_CLIENT_BINDING})(askDialog);
    (${WHM_NGINX_PROXY_CLIENT_BINDING})(askDialog);
    (${WHM_DNS_FILE_CLIENT_BINDING})(askDialog);
    (${WHM_IPS_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-network-2', 'xwhm', ["data-network-can-read","data-network-editable","data-whm-ip-tools","data-ip-tools-status","data-ip-change-form","data-ip-change-status","data-ip-change-many-form","data-ip-change-many-status","data-whm-reseller-email","data-whm-reseller-lists"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_NETWORK_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-backups-1', 'any', ["data-whm-backup-destinations","data-backup-inline-manager","data-approved-whm-backups","data-destination-form","data-backup-workspace-status","data-backup-can-read","data-backup-manage","data-backup-action","data-whm-backup-files-workspace","data-backup-files-","data-read-only","data-file","data-whm-backup-runs","data-backup-runs-status","data-backup-runs-loading","data-backup-runs-read","data-backup-runs-start","data-backup-retention-destination","data-backup-retention-preview","data-backup-retention-apply","data-backup-destinations-can-read","data-backup-destination-editor","data-destination-read","data-destination-new","data-destination-save"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_BACKUPS_CLIENT_BINDING})(askDialog);
    (${WHM_BACKUP_FILES_CLIENT_BINDING})();
    (${WHM_BACKUP_RUNS_CLIENT_BINDING})(askDialog);
    (${WHM_BACKUP_DESTINATIONS_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-backups-2', 'xwhm', ["data-account-backups","data-backup-account","data-backup-files","data-backup-status","data-backup-create","data-backup-local-read","data-read-only"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_LOCAL_ARCHIVES_CLIENT_BINDING})();
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-ssl', 'xwhm', ["data-whm-ssl","data-ssl-","data-ssl-can-read","data-ssl-can-manage","data-ssl-renew","data-ssl-remove","data-whm-ssl-install","data-ssl-install-","data-ssl-install-choices","data-ssl-install-can-read","data-ssl-install-can-manage","data-ssl-install-step","data-ssl-install-choice"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_SSL_CLIENT_BINDING})(askDialog);
    (${WHM_SSL_INSTALL_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-sec-1', 'any', ["data-whm-security-evidence","data-whm-security-check-rows","data-whm-security-configuration","data-whm-security-status","data-whm-security-refresh","data-read-only","data-api-url","data-whm-security-count","data-whm-ssh-keys","data-whm-ssh-key-rows","data-whm-ssh-public-key","data-whm-ssh-status","data-whm-ssh-refresh","data-whm-ssh-add","data-whm-ssh-window","data-whm-ssh-effective","data-whm-ssh-policy","data-whm-ssh-port","data-whm-ssh-auth","data-whm-ssh-root","data-whm-ssh-apply","data-whm-ssh-policy-status","data-whm-ssh-start","data-whm-ssh-stop","data-approved-whm-operations","data-operation-state","data-whm-ops-section","data-firewall-manage-status","data-whm-firewall-panel","data-firewall-rule-count","data-firewall-manage-head","data-firewall-static-management","data-whm-security-tools-workspace","data-whm-security-tools-status","data-whm-security-tools-refresh","data-whm-security-tools-result","data-whm-security-tools-fact","data-whm-security-tools-rows","data-whm-security-tools-filter","data-whm-updates-workspace","data-whm-updates-status","data-whm-updates-rows","data-whm-updates-job","data-whm-updates-job-link","data-whm-updates-exclude-kernel","data-whm-updates-action","data-cache","data-whm-repair-workspace","data-whm-repair-","data-whm-repair-preview-action","data-whm-firewall-ping","data-whm-firewall-policy","data-whm-isolation-policy"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_SECURITY_CLIENT_BINDING})();
    (${WHM_SSH_CLIENT_BINDING})(askDialog);
    (${WHM_SSH_POLICY_CLIENT_BINDING})(askDialog);
    (${WHM_FIREWALL_CLIENT_BINDING})(askDialog);
    (${WHM_SECURITY_TOOLS_CLIENT_BINDING})(askDialog);
    (${WHM_UPDATES_CLIENT_BINDING})(askDialog);
    (${WHM_REPAIR_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-sec-2', 'any', ["data-sign-in-policy","data-sign-in-status","data-sign-in-save","data-sign-in-refresh","data-sign-in-lockouts","data-sign-in-unlock-target","data-sign-in-unlock","data-sign-in-field"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${SIGN_IN_POLICY_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-server-1', 'xwhm', ["data-whm-php-workspace","data-whm-php-status","data-whm-php-refresh","data-read-only","data-api-url","data-php-action","data-presentation-tabs","data-presentation-tab","data-whm-service-detail-workspace","data-whm-service-detail-status","data-whm-service-detail-refresh","data-whm-service-detail-rows","data-whm-service-detail-result","data-whm-service-detail-restart","data-whm-service-detail-check","data-whm-service-detail-check-messages","data-svc-panel","data-svc-status","data-svc-input","data-svc-op","data-svc-row-button","data-svc-field","data-svc-rows","data-whm-service-manager","data-sm-status","data-sm-result","data-sm-refresh","data-sm-rows","data-sm-search","data-sm-filter","data-sm-confirm","data-whm-configuration-health","data-ch-status","data-ch-refresh","data-ch-targets","data-ch-tests","data-ch-target","data-ch-confirm","data-ch-repair","data-whm-server-observation","data-whm-server-observation-status","data-whm-server-observation-refresh","data-whm-server-observation-","data-whm-server-observation-owner","data-whm-server-observation-search","data-server-settings-status","data-server-settings-suggest","data-server-settings-form","data-server-settings-discard"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_PHP_CLIENT_BINDING})(askDialog);
    (${WHM_SERVICE_DETAIL_CLIENT_BINDING})(askDialog);
    (${SVC_PANELS_CLIENT_BINDING})(askDialog);
    (${WHM_SERVICE_MANAGER_CLIENT_BINDING})(askDialog);
    (${WHM_CONFIGURATION_HEALTH_CLIENT_BINDING})(askDialog);
    (${WHM_SERVER_OBSERVATION_CLIENT_BINDING})();
    ${SERVER_SETTINGS_SUGGEST_CLIENT_BINDING}
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-server-2', 'xwhm', ["data-read-only","data-whm-server-health","data-whm-server-health-","data-whm-server-health-account","data-whm-web-readback","data-whm-web-status","data-whm-web-refresh","data-server-settings-form","data-whm-web-generation","data-whm-web-rollback","data-whm-detail-section","data-web-directives-form","data-web-directives-can-read","data-web-directives-can-manage","data-web-directives-status","data-tweak-settings","data-tweak-status","data-tweak-save","data-tweak-refresh","data-tweak-search","data-tweak-empty","data-setting-row","data-setting-group","data-server-ops","data-server-ops-status","data-server-ops-submit","data-server-ops-rows","data-server-ops-job","data-host-tool","data-host-tool-status","data-host-tool-submit","data-host-tool-cancel","data-host-tool-rows","data-host-tool-log","data-host-tool-reveal","data-host-tool-job","data-host-info","data-host-info-status","data-host-load","data-host-memory","data-host-disk"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_SERVER_HEALTH_CLIENT_BINDING})();
    (${WHM_WEB_SERVER_CLIENT_BINDING})(askDialog);
    (${WHM_WEB_DIRECTIVES_CLIENT_BINDING})();
    (${WHM_TWEAK_SETTINGS_CLIENT_BINDING})();
    (${WHM_SERVER_OPS_CLIENT_BINDING})(askDialog);
    (${WHM_HOST_TOOLS_CLIENT_BINDING})(askDialog);
    (${WHM_SERVER_INFO_CLIENT_BINDING})();
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-mail', 'xwhm', ["data-whm-mail-queue-workspace","data-whm-mail-queue-status","data-whm-mail-queue-refresh","data-whm-mail-queue-rows","data-whm-mail-queue-result","data-whm-mail-queue-results","data-whm-mail-queue-select-all","data-whm-mail-queue-selected","data-read-only","data-whm-mail-log","data-mail-log-form","data-mail-log-status","data-mail-log-range","data-mail-log-submit","data-mail-log-fact","data-mail-log-custom","data-whm-ftp-log","data-ftp-log-form","data-ftp-log-status","data-ftp-log-range","data-ftp-log-submit","data-ftp-log-fact","data-ftp-log-custom","data-whm-mail-server-workspace","data-whm-mail-server-status","data-whm-mail-server-refresh","data-whm-mail-server-","data-whm-mail-server-fact","data-whm-mail-server-truncated","data-whm-mail-settings","data-whm-mail-quality-workspace","data-whm-mail-quality-status","data-whm-mail-quality-refresh","data-whm-mail-quality-check","data-whm-mail-quality-rows","data-whm-mail-quality-result","data-whm-mail-quality-select-all","data-whm-mail-quality-selected","data-whm-mailbox-maintenance-workspace","data-whm-mailbox-maintenance-status","data-whm-mailbox-maintenance-refresh","data-whm-mailbox-maintenance-search","data-whm-mailbox-maintenance-usage-status","data-whm-mailbox-maintenance-selected","data-whm-mailbox-maintenance-result","data-whm-mailbox-maintenance-job-link"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_MAIL_QUEUE_CLIENT_BINDING})(askDialog);
    (${WHM_MAIL_LOG_CLIENT_BINDING})();
    (${WHM_FTP_LOG_CLIENT_BINDING})();
    (${WHM_MAIL_SERVER_CLIENT_BINDING})();
    (${WHM_MAIL_QUALITY_CLIENT_BINDING})();
    (${WHM_MAILBOX_MAINTENANCE_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-panel-1', 'xwhm', ["data-whm-jobs-workspace","data-whm-jobs-status","data-whm-jobs-rows","data-whm-jobs-loading","data-whm-jobs-empty","data-whm-jobs-filters","data-whm-jobs-status-filter","data-whm-jobs-kind-filter","data-whm-panel-tokens-workspace","data-whm-tokens-status","data-whm-tokens-rows","data-whm-tokens-loading","data-whm-tokens-empty","data-whm-tokens-refresh","data-whm-tokens-revoke-status","data-whm-tokens-reveal","data-whm-panel-notifications-workspace","data-whm-notifications-status","data-whm-notifications-loading","data-whm-notifications-form","data-whm-notifications-recipients","data-whm-notifications-save","data-whm-notifications-reload","data-whm-notifications-save-status","data-whm-announcements-workspace","data-whm-announcements-status","data-whm-announcements-loading","data-whm-announcements-rows","data-whm-announcements-empty","data-whm-announcements-refresh","data-whm-announcements-list-status","data-whm-announcements-form","data-acct-enh-workspace","data-acct-enh-status","data-acct-enh-loading","data-acct-enh-refresh","data-acct-enh-save-status","data-acct-enh-empty","data-acct-enh-rows","data-acct-enh-form","data-whm-software-center","data-sc-status","data-sc-refresh","data-sc-groups","data-sc-category","data-sc-search","data-sc-preview","data-sc-confirm","data-whm-preferences-workspace","data-whm-preferences-form","data-whm-preferences-status","data-whm-preferences-save-status","data-whm-preferences-save","data-whm-preferences-reload","data-whm-preferences-apply","data-whm-preferences-loading"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_JOBS_CLIENT_BINDING})(askDialog);
    (${WHM_PANEL_TOKENS_CLIENT_BINDING})(askDialog);
    (${WHM_PANEL_NOTIFICATIONS_CLIENT_BINDING})();
    (${WHM_ANNOUNCEMENTS_CLIENT_BINDING})(askDialog);
    (${WHM_ENHANCEMENTS_CLIENT_BINDING})(askDialog);
    (${WHM_SOFTWARE_CENTER_CLIENT_BINDING})(askDialog);
    (${WHM_PREFERENCES_CLIENT_BINDING})();
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-panel-2', 'any', ["data-panel-settings-workspace","data-panel-settings-status","data-panel-settings-save-status","data-panel-settings-updated","data-panel-settings-save","data-panel-settings-reload","data-panel-settings-input","data-read-only","data-branding-workspace","data-branding-status","data-branding-save-status","data-branding-asset-status","data-branding-save","data-branding-reload","data-branding-state","data-branding-updated","data-whm-languages-workspace","data-whm-languages-status","data-whm-languages-loading","data-whm-languages-catalog-status","data-whm-languages-errors","data-whm-languages-form","data-whm-languages-default","data-whm-languages-save","data-whm-whmcs-workspace","data-whm-whmcs-form","data-whm-whmcs-status","data-whm-whmcs-loading","data-whm-whmcs-save","data-whm-whmcs-reload","data-whm-whmcs-save-status","data-whm-whmcs-input","data-developer-workspace","data-dev-form","data-dev-operation","data-dev-run","data-dev-refresh","data-dev-copy","data-dev-status","data-dev-result-fields","data-demo-mode-workspace","data-demo-mode-status","data-demo-mode-result","data-demo-mode-account","data-demo-mode-enable","data-demo-mode-disable","data-demo-mode-refresh","data-whm-trusted-proxies-workspace","data-trusted-proxies-form","data-trusted-proxies-status","data-trusted-proxies-save-status","data-trusted-proxies-apply-status","data-trusted-proxies-cidrs","data-trusted-proxies-save","data-trusted-proxies-reload","data-whm-composer","data-composer-status","data-composer-refresh","data-composer-target","data-composer-packages","data-composer-run-action","data-composer-review","data-composer-run","data-account-plugins","data-hooks-workspace","data-plugin-packages-workspace","data-registered-apps-workspace","data-site-software-workspace","data-theme-packages-workspace"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_PANEL_SETTINGS_CLIENT_BINDING})(askDialog);
    (${WHM_PANEL_BRANDING_CLIENT_BINDING})(askDialog);
    (${WHM_LANGUAGES_CLIENT_BINDING})(askDialog);
    (${WHM_WHMCS_CLIENT_BINDING})(askDialog);
    (${WHM_DEVELOPER_CLIENT_BINDING})();
    (${WHM_EXTEND_CLIENT_BINDING})(askDialog);
    (${WHM_TRUSTED_PROXIES_CLIENT_BINDING})();
    (${WHM_COMPOSER_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-panel-3', 'xwhm', ["data-whm-support-workspace","data-whm-support-status","data-whm-support-bundle-status","data-whm-support-refresh","data-whm-support-confirm","data-whm-support-download","data-whm-support-contact","data-read-only","data-whm-generations","data-generations-status","data-generation-rows","data-generations-current"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_SUPPORT_CLIENT_BINDING})();
    (${WHM_PANEL_DATA_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-db', 'any', ["data-whm-databases","data-whm-db-status","data-whm-db-refresh","data-whm-db-search","data-whm-db-drift-filter","data-whm-db-filter-empty","data-read-only","data-whm-db-maint-database","data-db-tuning-read","data-db-tuning-status","data-db-tuning-plan","data-db-tuning-rows","data-db-tuning-fact","data-whm-database-tuning","data-db-engine","data-db-status","data-db-action","data-db-rows","data-db-pg-form","data-db-pg-act","data-db-fact","data-db-checks"], true, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_DATABASES_CLIENT_BINDING})(askDialog);
    (${DB_FTP_CLIENT_BINDINGS})(askDialog);
    (${WHM_DATABASE_TUNING_CLIENT_BINDING})();
    (${DB_ENGINES_CLIENT_BINDING})(askDialog, rtl);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-monitoring', 'xwhm', ["data-whm-benchmark","data-benchmark-form","data-benchmark-confirm","data-benchmark-start","data-benchmark-refresh","data-benchmark-status","data-benchmark-history","data-whm-traffic","data-traffic-refresh","data-traffic-status","data-traffic-table","data-traffic-observed","data-traffic-interval","data-traffic-coverage","data-whm-metering","data-whm-metering-refresh","data-whm-metering-status","data-whm-metering-fact","data-whm-metering-rows","data-whm-metering-count","data-whm-bandwidth-relief","data-whm-bandwidth-relief-status","data-whm-log-tools","data-log-analysis-site","data-log-analysis-run","data-log-analysis-status","data-log-analysis-rows","data-log-analysis-samples","data-database-log-kind","data-database-log-read","data-read-only","data-whm-monitoring","data-whm-monitoring-status","data-whm-monitoring-refresh","data-whm-monitoring-","data-whm-monitoring-kill-user","data-whm-monitoring-rows","data-whm-monitoring-account-rows","data-whm-monitoring-alerts-workspace","data-whm-alerts-","data-whm-alerts-rule","data-whm-alerts-fact","data-whm-alerts-threshold","data-whm-alerts-title","data-whm-alerts-unit","data-account-limits-form","data-whm-quotas","data-whm-raw-logs"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_BENCHMARK_CLIENT_BINDING})();
    (${WHM_TRAFFIC_CLIENT_BINDING})();
    (${WHM_METERING_CLIENT_BINDING})(askDialog);
    (${WHM_LOG_TOOLS_CLIENT_BINDING})();
    (${WHM_MONITORING_CLIENT_BINDING})(askDialog);
    (${WHM_MONITORING_ALERTS_CLIENT_BINDING})();
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('mail-ext', 'any', ["data-mailx-whm","data-mailx-status","data-mailx-refresh","data-mailx-form","data-mailx-save","data-mailx-apply","data-mailx-form-status","data-read-only","data-mailx-archive","data-mailx-archive-status","data-mailx-archive-refresh","data-mailx-archive-rows","data-mailx-archive-form","data-mailx-archive-save","data-mailx-archive-form-status","data-mailx-collections","data-mailx-collections-can-read","data-mailx-can-manage","data-mailx-","data-mailx-descriptions","data-mailx-address-books","data-mailx-task-lists","data-mailx-add","data-mailx-tools","data-mailx-tools-section","data-mailx-lists-status","data-mailx-lists-rows","data-mailx-lists-refresh","data-mailx-lists-apply","data-mailx-lists-action-status"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${MAILX_WHM_CLIENT_BINDING})();
    (${MAILX_ARCHIVE_CLIENT_BINDING})(askDialog);
    (${MAILX_COLLECTIONS_CLIENT_BINDING})(askDialog);
    (${MAILX_MAIL_TOOLS_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('whm-transfers', 'xwhm', ["data-read-only","data-whm-upgrade-workspace","data-upgrade-fact","data-upgrade-banner","data-upgrade-status","data-upgrade-preflight-summary","data-upgrade-progress","data-upgrade-target","data-transfer-workspace","data-transfer-can-read","data-transfer-manage","data-transfer-field","data-transfer-","data-transfer-session","data-transfer-credential","data-transfer-node"], false, `(function(){
  function run(){
    if(typeof window==='undefined'||typeof window.xpanelSessionRequest!=='function')return;
    var __rt=window.__xpRt;if(!__rt)return;
    var askDialog=__rt.askDialog,rtl=document.documentElement.dir==='rtl',clientTemplate=__rt.clientTemplate,clientTemplateSlot=__rt.clientTemplateSlot,cloneClientTemplate=__rt.cloneClientTemplate,reload=__rt.reload;
    (${WHM_UPGRADE_CLIENT_BINDING})();
    (${WHM_TRANSFER_CLIENT_BINDING})(askDialog);
  }
  if(window.__xpRt&&Array.isArray(window.__xpRt.rebinders))window.__xpRt.rebinders.push(run);
  run();
})();`),
  chunk('panel-resources', 'xpanel', ["data-panel-resources-live"], false, `(function(){
  if(typeof window==='undefined')return;
  ${PANEL_RESOURCES_CLIENT_BINDING}();
})();`),
  chunk('whm-account-preflight', 'xwhm', ["data-account-preflight-url"], false, `(function(){
  if(typeof window==='undefined')return;
  ${ACCOUNT_PREFLIGHT_CLIENT_BINDING}();
})();`)
])

/** Selects only the domain chunks required by the rendered surface HTML. */
export function routeClientChunksFor(surface: string, bodyHtml: string): readonly RouteClientChunk[] {
  const matched: RouteClientChunk[] = []
  for (const item of ROUTE_CLIENT_CHUNKS) {
    if (item.surface !== 'any' && item.surface !== surface) continue
    if (item.alwaysForSurface || item.hooks.some(hook => bodyHtml.includes(hook))) {
      matched.push(item)
    }
  }
  return matched
}

export function routeClientChunkTags(surface: string, bodyHtml: string): string {
  const items = routeClientChunksFor(surface, bodyHtml)
  return items.map(item => pageScriptTag(item.script, `xpanel-chunk-${item.id}`)).join('\n  ')
}

/** Concatenated source of every registered route-scoped client chunk. */
export function allRouteClientChunkSources(): string {
  return ROUTE_CLIENT_CHUNKS.map(item => item.script.body).join('\n')
}

/** Concatenated chunk source matching a rendered HTML fragment across surfaces. */
export function routeClientScriptForHtml(bodyHtml: string): string {
  const matched: string[] = []
  for (const item of ROUTE_CLIENT_CHUNKS) {
    if (item.alwaysForSurface || item.hooks.some(hook => bodyHtml.includes(hook))) {
      matched.push(item.script.body)
    }
  }
  return matched.join('\n')
}
