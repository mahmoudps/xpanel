# Design coverage

**2 of 44 boards done.**

Done means the row is Merged+gated or Blocked with a reason. Nothing in this ledger is Merged+gated. The strict gate is ≤0.5% of the page and ≤1% of every 200×200 tile, with the board's sample content injected only in the test, on the product route. A merged screen stays **Not started** until that gate is in a merged commit. Local numbers below are from an uncommitted run and are not a merge. The open Accounts, Create account, and Email PRs were measured on the product route with live-shaped data (1.94%, 6.76%, and 3.20%). Those figures are not the strict method, so their static-gate cell stays a dash.

The claude-export has 44 `.dc.html` files. The only variant files are Home (English), Home (Arabic), and Home (phone). There is no separate empty, error, or modal file. HTTP 403, 404, 421, 500, and 503 are product error responses without a board.

`/` and `/panel` open `/home`. `/mail` opens `/mail/inbox`. `/panel/<route>` opens that xPanel route. `/design/system`, `/design/components`, and `/design/navigation` exist only when `XPANEL_DESIGN_PAGES=1`.

Motion gate is **not measured** on every row. Data binding is `real` where the product route reads a live source, or `empty-state coming soon` where the screen stays empty until its tool is connected. A dash means this ledger has not classified that route.

Update this file in every PR that changes a row. Names, routes, and status only.

## Boards

| Board file | Surface | Product route | Status | Static gate % | Motion gate | Data binding | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| General · Home/PanelHome.dc.html | xPanel | /home | Not started | 0.00% page, 0% tiles (local, not merged) | not measured | real | [PR](https://github.com/mahmoudps/xpanel/pull/14) |
| General · Home — phone/PanelHomeMobile.dc.html | xPanel | /home (390×844) | Not started | 0.00% page, 0% tiles (local, not merged) | not measured | real | [PR](https://github.com/mahmoudps/xpanel/pull/14) |
| General · Home — Arabic (RTL)/PanelHomeAr.dc.html | xPanel | /home?lang=ar | Blocked: Arabic typography (#20) is a visual check, not a pixel gate | — | not measured | real | [PR](https://github.com/mahmoudps/xpanel/pull/20) |
| General · Resources & quotas/PanelResources.dc.html | xPanel | /resources | Not started | — | not measured | real | — |
| Email · Email accounts/PanelEmail.dc.html | xPanel | /email/accounts | PR open | — | not measured | real; pending fields empty-state coming soon | [PR](https://github.com/mahmoudps/xpanel/pull/30) |
| Files · File manager/PanelFiles.dc.html | xPanel | /files/manager | Not started | — | not measured | real | — |
| Files · Directory privacy/PanelSite.dc.html | xPanel | /files/directory-privacy | Not started | — | not measured | empty-state coming soon | — |
| Files · Backup/PanelBackup.dc.html | xPanel | /files/backup | Not started | — | not measured | empty-state coming soon | — |
| Databases · MariaDB databases/PanelDatabases.dc.html | xPanel | /databases/mariadb | Not started | — | not measured | real | — |
| Domains · Domains/PanelDomains.dc.html | xPanel | /domains | Not started | — | not measured | real | — |
| Domains · Zone editor/PanelDns.dc.html | xPanel | /domains/zone-editor | Not started | — | not measured | real | — |
| Metrics · Traffic & bandwidth/PanelMetrics.dc.html | xPanel | /metrics/traffic | Not started | — | not measured | real | — |
| Security · SSL TLS/PanelSsl.dc.html | xPanel | /security/ssl | Not started | — | not measured | real | — |
| Security · Account security/PanelSecurity.dc.html | xPanel | /security/account | Not started | — | not measured | real | — |
| xPanel Software · PHP/PanelPhp.dc.html | xPanel | /software/php | Not started | — | not measured | empty-state coming soon | — |
| Software · .htaccess editor/PanelHtaccess.dc.html | xPanel | /software/htaccess | Not started | — | not measured | empty-state coming soon | — |
| Advanced · Cron jobs/PanelCron.dc.html | xPanel | /advanced/cron | Not started | — | not measured | empty-state coming soon | — |
| Design system/Main.dc.html | xPanel | /design/system | Not started | — | not measured | — | — |
| Navigation map — all 187 pages/NavMap.dc.html | xPanel | /design/navigation | Not started | — | not measured | — | — |
| Premium components/Components.dc.html | xPanel | /design/components | Not started | — | not measured | — | — |
| Home · Dashboard/WhmDashboard.dc.html | xWHM | /whm | Not started | 0.57% page, worst tile 6.74% (fail, local) | not measured | real | [PR](https://github.com/mahmoudps/xpanel/pull/15) |
| Home · Audit log/WhmAudit.dc.html | xWHM | /whm/audit | Not started | — | not measured | real | [PR](https://github.com/mahmoudps/xpanel/pull/22) |
| Accounts · Accounts/WhmAccounts.dc.html | xWHM | /whm/accounts | PR open | — | not measured | real; pending fields empty-state coming soon | [PR](https://github.com/mahmoudps/xpanel/pull/27) |
| Accounts · Create account/WhmAccountCreate.dc.html | xWHM | /whm/accounts/new | PR open | — | not measured | real | [PR](https://github.com/mahmoudps/xpanel/pull/28) |
| Plans · Plans/WhmPlans.dc.html | xWHM | /whm/plans | Not started | — | not measured | real | — |
| Plans · Feature lists/WhmFeatures.dc.html | xWHM | /whm/plans/features | Not started | — | not measured | empty-state coming soon | — |
| Resellers · Resellers/WhmResellers.dc.html | xWHM | /whm/resellers | Not started | — | not measured | real | — |
| Domains, DNS & SSL · Domains/WhmDomains.dc.html | xWHM | /whm/domains | Not started | — | not measured | empty-state coming soon | — |
| Domains, DNS & SSL · DNS zones/WhmDns.dc.html | xWHM | /whm/dns | Not started | — | not measured | real | — |
| Domains, DNS & SSL · SSL certificates/WhmSsl.dc.html | xWHM | /whm/ssl | Not started | — | not measured | empty-state coming soon | — |
| Security center · Security advisor/WhmSecurity.dc.html | xWHM | /whm/security | Not started | — | not measured | empty-state coming soon | — |
| Security center · Firewall/WhmFirewall.dc.html | xWHM | /whm/security/firewall | Not started | — | not measured | real | — |
| Security center · SSH/WhmSsh.dc.html | xWHM | /whm/security/ssh | Not started | — | not measured | empty-state coming soon | — |
| Services · Services/WhmServices.dc.html | xWHM | /whm/services | Not started | — | not measured | real | — |
| Services · Web server/WhmWebServer.dc.html | xWHM | /whm/services/web | Not started | — | not measured | empty-state coming soon | — |
| Backups & transfers · Backups/WhmBackups.dc.html | xWHM | /whm/backups | Not started | — | not measured | real | — |
| Backups & transfers · Transfer tool/WhmTransfer.dc.html | xWHM | /whm/transfers | Not started | — | not measured | real | — |
| xWHM Software · PHP/WhmPhp.dc.html | xWHM | /whm/software/php | Not started | — | not measured | empty-state coming soon | — |
| Server · Setup & settings/WhmSetup.dc.html | xWHM | /whm/server/setup | Not started | — | not measured | empty-state coming soon | — |
| Server · Upgrade/WhmUpgrade.dc.html | xWHM | /whm/server/upgrade | Not started | — | not measured | real | — |
| Mail · Inbox/MailInbox.dc.html | xMail | /mail/inbox | Not started | 0.88% page, worst tile 10.90% (fail, local) | not measured | real | [PR](https://github.com/mahmoudps/xpanel/pull/16) |
| Mail · Compose/MailCompose.dc.html | xMail | /mail/compose | Not started | 1.38% page, worst tile 9.88% (fail, local) | not measured | real | [PR](https://github.com/mahmoudps/xpanel/pull/17) |
| Sign in/Login.dc.html | auth | /login | Not started | — | not measured | real | — |
| Build map/BuildMap.dc.html | — | — | Blocked: no product route | — | not measured | — | — |

## Product routes without a board

171 routes. Each is Blocked because claude-export has no file for that route. A catalog artboard name is the name in navigation, not an exported file. These rows are not part of the 44.

| Board file | Surface | Product route | Status | Static gate % | Motion gate | Data binding | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| — | xPanel | /advanced/api-shell | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /advanced/error-pages | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /advanced/handlers | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /advanced/indexes | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /advanced/mime-types | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /advanced/network-tools | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /advanced/terminal | Blocked: no exported board (catalog name PanelTerminal) | — | not measured | — | — |
| — | xPanel | /databases/insights | Blocked: no exported board (catalog name PanelDbInsights) | — | not measured | — | — |
| — | xPanel | /databases/phpmyadmin | Blocked: no exported board (catalog name PanelPhpMyAdmin) | — | not measured | — | — |
| — | xPanel | /databases/phppgadmin | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /databases/postgresql | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /databases/remote-access | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /domains/cloudflare | Blocked: no exported board (catalog name PanelCloudflare) | — | not measured | — | — |
| — | xPanel | /domains/dynamic-dns | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /domains/redirects | Blocked: no exported board (catalog name PanelSite) | — | not measured | — | — |
| — | xPanel | /domains/reverse-proxy | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /domains/site-publisher | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /domains/site-settings | Blocked: no exported board (catalog name PanelSite) | — | not measured | — | — |
| — | xPanel | /domains/staging | Blocked: no exported board (catalog name PanelStaging) | — | not measured | — | — |
| — | xPanel | /email/archive | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /email/calendars-contacts | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /email/deliverability | Blocked: no exported board (catalog name PanelEmail) | — | not measured | — | — |
| — | xPanel | /email/encryption | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /email/filters | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /email/forwarders | Blocked: no exported board (catalog name PanelEmail) | — | not measured | — | — |
| — | xPanel | /email/mailing-lists | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /email/spam-filters | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /email/spam-quarantine | Blocked: no exported board (catalog name PanelQuarantine) | — | not measured | — | — |
| — | xPanel | /files/ftp | Blocked: no exported board (catalog name PanelFtp) | — | not measured | — | — |
| — | xPanel | /files/git | Blocked: no exported board (catalog name PanelGit) | — | not measured | — | — |
| — | xPanel | /files/trash | Blocked: no exported board (catalog name PanelFiles) | — | not measured | — | — |
| — | xPanel | /files/web-disk | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /health | Blocked: no exported board (catalog name PanelHealth) | — | not measured | — | — |
| — | xPanel | /metrics/logs | Blocked: no exported board (catalog name PanelLogs) | — | not measured | — | — |
| — | xPanel | /metrics/web-stats | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /preferences | Blocked: no exported board (catalog name PanelPreferences) | — | not measured | — | — |
| — | xPanel | /preferences/language | Blocked: no exported board (catalog name PanelPreferences) | — | not measured | — | — |
| — | xPanel | /preferences/team | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /preferences/users | Blocked: no exported board (catalog name PanelEmail) | — | not measured | — | — |
| — | xPanel | /security/hotlink | Blocked: no exported board (catalog name PanelSite) | — | not measured | — | — |
| — | xPanel | /security/ip-blocker | Blocked: no exported board (catalog name PanelSite) | — | not measured | — | — |
| — | xPanel | /security/ssh | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /security/ssl/files | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /security/ssl/issue | Blocked: no exported board (catalog name PanelSsl) | — | not measured | — | — |
| — | xPanel | /security/virus-scanner | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /security/waf | Blocked: no exported board (catalog name PanelWaf) | — | not measured | — | — |
| — | xPanel | /server-information | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /software/apps | Blocked: no exported board (catalog name PanelRuntimeApps) | — | not measured | — | — |
| — | xPanel | /software/cache | Blocked: no exported board (catalog name PanelCache) | — | not measured | — | — |
| — | xPanel | /software/containers | Blocked: no exported board (catalog name PanelContainers) | — | not measured | — | — |
| — | xPanel | /software/installer | Blocked: no exported board (catalog name PanelApps) | — | not measured | — | — |
| — | xPanel | /software/optimize | Blocked: no exported board | — | not measured | — | — |
| — | xPanel | /software/packages | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/accounts/announcements | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/accounts/bandwidth | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/accounts/health | Blocked: no exported board (catalog name WhmAccountHealth) | — | not measured | — | — |
| — | xWHM | /whm/accounts/templates | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/backups/destinations | Blocked: no exported board (catalog name WhmBackups) | — | not measured | — | — |
| — | xWHM | /whm/backups/files | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/backups/restore | Blocked: no exported board (catalog name WhmRestore) | — | not measured | — | — |
| — | xWHM | /whm/backups/restore-more | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/databases | Blocked: no exported board (catalog name WhmDatabases) | — | not measured | — | — |
| — | xWHM | /whm/databases/mongodb | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/databases/phpmyadmin | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/databases/processes | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/databases/redis | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/databases/servers | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/databases/tuning | Blocked: no exported board (catalog name WhmDbTuning) | — | not measured | — | — |
| — | xWHM | /whm/databases/upgrade | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/databases/users | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/dns/cluster | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/dns/more | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/dns/providers | Blocked: no exported board (catalog name WhmCloudflare) | — | not measured | — | — |
| — | xWHM | /whm/email/bcc | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/email/delivery | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/email/maintenance | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/email/marketing | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/email/monitor | Blocked: no exported board (catalog name WhmMailMonitor) | — | not measured | — | — |
| — | xWHM | /whm/email/outbound | Blocked: no exported board (catalog name WhmOutboundSpam) | — | not measured | — | — |
| — | xWHM | /whm/email/quality | Blocked: no exported board (catalog name WhmMailQuality) | — | not measured | — | — |
| — | xWHM | /whm/email/queue | Blocked: no exported board (catalog name WhmMailQueue) | — | not measured | — | — |
| — | xWHM | /whm/email/relay | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/email/routing | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/email/server | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/email/spam | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/jobs | Blocked: no exported board (catalog name WhmJobs) | — | not measured | — | — |
| — | xWHM | /whm/monitoring/alerts | Blocked: no exported board (catalog name WhmAlerts) | — | not measured | — | — |
| — | xWHM | /whm/monitoring/benchmark | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/monitoring/disk | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/monitoring/health | Blocked: no exported board (catalog name WhmServerHealth) | — | not measured | — | — |
| — | xWHM | /whm/monitoring/io | Blocked: no exported board (catalog name WhmIo) | — | not measured | — | — |
| — | xWHM | /whm/monitoring/limits | Blocked: no exported board (catalog name WhmResourceLimits) | — | not measured | — | — |
| — | xWHM | /whm/monitoring/logs | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/monitoring/performance | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/monitoring/processes | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/monitoring/repair | Blocked: no exported board (catalog name WhmRepair) | — | not measured | — | — |
| — | xWHM | /whm/monitoring/server-info | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/monitoring/traffic | Blocked: no exported board (catalog name WhmTraffic) | — | not measured | — | — |
| — | xWHM | /whm/panel/api-tokens | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/panel/branding | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/panel/data | Blocked: no exported board (catalog name WhmPanelData) | — | not measured | — | — |
| — | xWHM | /whm/panel/developer | Blocked: no exported board (catalog name WhmDeveloper) | — | not measured | — | — |
| — | xWHM | /whm/panel/integrations | Blocked: no exported board (catalog name WhmIntegrations) | — | not measured | — | — |
| — | xWHM | /whm/panel/languages | Blocked: no exported board (catalog name WhmLanguages) | — | not measured | — | — |
| — | xWHM | /whm/panel/notifications | Blocked: no exported board (catalog name WhmNotifications) | — | not measured | — | — |
| — | xWHM | /whm/panel/settings | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/panel/whmcs | Blocked: no exported board (catalog name WhmWhmcs) | — | not measured | — | — |
| — | xWHM | /whm/plans/enhancements | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/preferences | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/resellers/ips-nameservers | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/resellers/more | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/resellers/privileges | Blocked: no exported board (catalog name WhmResellers) | — | not measured | — | — |
| — | xWHM | /whm/security/antivirus | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/security/flood | Blocked: no exported board (catalog name WhmFlood) | — | not measured | — | — |
| — | xWHM | /whm/security/intrusion | Blocked: no exported board (catalog name WhmIntrusion) | — | not measured | — | — |
| — | xWHM | /whm/security/isolation | Blocked: no exported board (catalog name WhmIsolation) | — | not measured | — | — |
| — | xWHM | /whm/security/panel-access | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/security/sign-in | Blocked: no exported board (catalog name WhmSecurity) | — | not measured | — | — |
| — | xWHM | /whm/security/waf | Blocked: no exported board (catalog name WhmWaf) | — | not measured | — | — |
| — | xWHM | /whm/server/cron | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/server/file-sharing | Blocked: no exported board (catalog name TemplateList) | — | not measured | — | — |
| — | xWHM | /whm/server/ips | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/server/networking | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/server/nodes | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/server/role | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/server/terminal | Blocked: no exported board (catalog name WhmTerminal) | — | not measured | — | — |
| — | xWHM | /whm/server/trusted-proxies | Blocked: no exported board (catalog name WhmTrustedProxies) | — | not measured | — | — |
| — | xWHM | /whm/services/certificates | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/services/default-index | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/services/dns | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/services/ftp | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/services/ftp-log-analysis | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/services/health | Blocked: no exported board (catalog name WhmConfigHealth) | — | not measured | — | — |
| — | xWHM | /whm/services/more | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/software/addon-services | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/software/application-projects | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/software/catalog | Blocked: no exported board (catalog name WhmSoftwareCenter) | — | not measured | — | — |
| — | xWHM | /whm/software/composer | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/software/containers | Blocked: no exported board (catalog name WhmContainers) | — | not measured | — | — |
| — | xWHM | /whm/software/containers/engine | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/software/deployments | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/software/modules | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/software/runtimes | Blocked: no exported board (catalog name WhmRuntimes) | — | not measured | — | — |
| — | xWHM | /whm/software/site-software | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/software/updates | Blocked: no exported board (catalog name WhmUpdates) | — | not measured | — | — |
| — | xWHM | /whm/ssl/install | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/support | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/transfers/convert-addon | Blocked: no exported board | — | not measured | — | — |
| — | xWHM | /whm/transfers/server | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/calendar | Blocked: no exported board (catalog name MailCalendar) | — | not measured | — | — |
| — | xMail | /mail/contacts | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/folders | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/later | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/overview | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/settings/autoresponder | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/settings/calendars | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/settings/filters | Blocked: no exported board (catalog name MailFilters) | — | not measured | — | — |
| — | xMail | /mail/settings/forwarders | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/settings/identities | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/settings/preferences | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/settings/security | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/settings/spam | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/tools/connect-devices | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/tools/disk-usage | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/tools/mailing-lists | Blocked: no exported board | — | not measured | — | — |
| — | xMail | /mail/tools/track-delivery | Blocked: no exported board | — | not measured | — | — |
| — | error | HTTP 403 | Blocked: no exported board | — | not measured | real | — |
| — | error | HTTP 404 | Blocked: no exported board | — | not measured | real | — |
| — | error | HTTP 421 | Blocked: no exported board | — | not measured | real | — |
| — | error | HTTP 500 | Blocked: no exported board | — | not measured | real | — |
| — | error | HTTP 503 | Blocked: no exported board | — | not measured | real | — |

## Queue

Finish the open work before these rows: the strict-gate follow-up (Home, Home phone, Dashboard, Inbox, Compose), then the open screen PRs (#27 Accounts, #28 Create account, #30 Email accounts), then the motion track.

Not started boards after that, in navigation order:

1. `General · Resources & quotas/PanelResources.dc.html` → `/resources`
2. `Files · File manager/PanelFiles.dc.html` → `/files/manager`
3. `Files · Directory privacy/PanelSite.dc.html` → `/files/directory-privacy`
4. `Files · Backup/PanelBackup.dc.html` → `/files/backup`
5. `Databases · MariaDB databases/PanelDatabases.dc.html` → `/databases/mariadb`
6. `Domains · Domains/PanelDomains.dc.html` → `/domains`
7. `Domains · Zone editor/PanelDns.dc.html` → `/domains/zone-editor`
8. `Metrics · Traffic & bandwidth/PanelMetrics.dc.html` → `/metrics/traffic`
9. `Security · SSL TLS/PanelSsl.dc.html` → `/security/ssl`
10. `Security · Account security/PanelSecurity.dc.html` → `/security/account`
11. `xPanel Software · PHP/PanelPhp.dc.html` → `/software/php`
12. `Software · .htaccess editor/PanelHtaccess.dc.html` → `/software/htaccess`
13. `Advanced · Cron jobs/PanelCron.dc.html` → `/advanced/cron`
14. `Home · Audit log/WhmAudit.dc.html` → `/whm/audit`
15. `Plans · Plans/WhmPlans.dc.html` → `/whm/plans`
16. `Plans · Feature lists/WhmFeatures.dc.html` → `/whm/plans/features`
17. `Resellers · Resellers/WhmResellers.dc.html` → `/whm/resellers`
18. `Domains, DNS & SSL · Domains/WhmDomains.dc.html` → `/whm/domains`
19. `Domains, DNS & SSL · DNS zones/WhmDns.dc.html` → `/whm/dns`
20. `Domains, DNS & SSL · SSL certificates/WhmSsl.dc.html` → `/whm/ssl`
21. `Security center · Security advisor/WhmSecurity.dc.html` → `/whm/security`
22. `Security center · Firewall/WhmFirewall.dc.html` → `/whm/security/firewall`
23. `Security center · SSH/WhmSsh.dc.html` → `/whm/security/ssh`
24. `Services · Services/WhmServices.dc.html` → `/whm/services`
25. `Services · Web server/WhmWebServer.dc.html` → `/whm/services/web`
26. `Backups & transfers · Backups/WhmBackups.dc.html` → `/whm/backups`
27. `Backups & transfers · Transfer tool/WhmTransfer.dc.html` → `/whm/transfers`
28. `xWHM Software · PHP/WhmPhp.dc.html` → `/whm/software/php`
29. `Server · Setup & settings/WhmSetup.dc.html` → `/whm/server/setup`
30. `Server · Upgrade/WhmUpgrade.dc.html` → `/whm/server/upgrade`
31. `Premium components/Components.dc.html` → `/design/components`
32. `Navigation map — all 187 pages/NavMap.dc.html` → `/design/navigation`
33. `Design system/Main.dc.html` → `/design/system`
34. `Sign in/Login.dc.html` → `/login`
