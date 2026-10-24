# Phase 1 tools

The live sidebars stay empty while every in-scope catalog tool is `researched`. This note records why, which tools now have a real path, and what the lab still has to install before a tool can appear.

## How a tool becomes visible

`packages/catalog/src/data/delivery.ts` ships `deliveryEvidence = []` and `deliveryTarget = null`. `assessDelivery` therefore marks every in-scope tool `researched`. Production catalog tests keep that static result: nothing in the shipped catalog is `verified`.

`isVisible` (`packages/catalog/src/visibility.ts`) shows a tool only when both `tool.status` and `tool.delivery.status` are `verified`, the surface matches, and root, reseller ACL, and feature-list rules pass. `visibleNavigation` then keeps a page only when **every** tool on that page is visible. The home shell renders those pages as links. Every other catalog group stays a disabled row labelled “Not yet available”.

Stuffing synthetic `CapabilityEvidence` into the static catalog would mark tools verified on every install, including ones this host cannot run. That is not the gate.

## Runtime availability checks

`qualifyHostTools` copies the catalog and assigns its runtime `verified` availability label only when all of the following are true:

- `XPANEL_HOST_QUALIFICATION` is not `off`
- the agent health report says `executor: "linux"` (a fake executor never qualifies)
- the tool is in `PHASE1_TOOL_PROBES`
- every probe that tool names is `passed`

The API adds `control-plane: passed` after it can read agent `/health`. The agent reports the other probes from binaries on the host, cached for 30 seconds. The qualified catalog is cached in the API for 15 seconds. `GET /api/catalog` and the sidebar both read that copy. The unprivileged API still reaches the host only through the root agent.

| Probe | Passes when |
| --- | --- |
| `control-plane` | The API reached agent `/health` |
| `linux-account` | `/usr/sbin/useradd` exists |
| `apache` | `/usr/sbin/apachectl`, `/usr/sbin/apache2`, or `/usr/sbin/httpd` exists |
| `mariadb` | `/usr/bin/mariadb` or `/usr/bin/mysql` exists |
| `mail` | `/usr/sbin/postfix` and (`/usr/sbin/dovecot` or `/usr/bin/doveadm`) exist |
| `files` | The agent was started with the confined helper `/opt/xpanel/bin/xpanel-account-files` |
| `acme` | The in-repo HTTP-01 client is built into the Linux agent. `certbot`, `lego`, or `acme.sh` also pass the probe. The probe fails when nginx cannot traverse `/var/lib/xpanel` and read `/var/lib/xpanel/acme`. Issuance uses the in-repo client |
| `pdns` | `/usr/bin/pdnsutil`, `/usr/bin/pdns_control`, or `/usr/sbin/pdns_server` exists |
| `backups` | `/var/lib/xpanel` exists. The agent creates `/var/lib/xpanel/backups` on first use. `XPANEL_BACKUP_DIR` overrides that directory |
| `systemd` | `/usr/bin/systemctl` exists |
| `host-info` | The agent read and parsed `/proc/loadavg` and `/proc/meminfo`. A path that exists but cannot be read fails the probe. The screen also reads `df -B1 -P /` |

These probes govern runtime navigation admission. Binary presence, agent reachability and the catalog's `verified` label are not independent hosting acceptance or proof of a completed tenant operation. `test:linux` supplies bounded executor evidence when its real prerequisites are met; it does not flip the static catalog or replace current target-host service, recovery and external-observer evidence.

## Source paths admitted by the probes

A page is hidden until every tool on it qualifies. Feature keys must not be in the plan’s disabled list (`domains` and `addondomains`, `popaccts (Email Accounts)`, `mysql`, `filemanager`, `AutoSSL`).

| Tool | Probes | Implemented source path; native acceptance remains separate |
| --- | --- | --- |
| `list-accounts`, `modify-account`, `password-modification` | control-plane | List, contact email, password |
| `manage-account-suspension`, `terminate-accounts` | control-plane, linux-account | Suspend, unsuspend, and terminate. Terminate also needs the Linux purge route |
| `add-package`, `edit-package`, `delete-package` | control-plane | Plan create and delete. Edit remains the existing plan API |
| `create-account` | control-plane, linux-account, apache | Create with the primary shared IPv4. `ip -j addr` marks the address observed when it is on the host; otherwise the result stays unverified |
| `domains`, `create-domain` | control-plane, apache | List, add addon or subdomain, remove |
| `email-accounts`, `email-account-create`, `email-account-manage` | control-plane, mail | Mailbox create, list, password, quota, delete. Reconcile writes Postfix/Dovecot config |
| `mysql-databases`, `mysql-users` | control-plane, mariadb | Database and user create, grant, delete |
| `file-manager`, `file-text-editor` | control-plane, files | Browse, text edit, binary upload and download up to 2 MiB, mkdir, trash, empty trash inside the account home |
| `ssl-tls-status` | control-plane | Stored certificate state per domain |
| `ssl-install` | control-plane, apache, acme | Issue or renew one account domain over HTTP-01 |
| `webmail-message-list`, `webmail-message-read` | control-plane, mail | Mailbox sign-in, inbox list, read and delete over IMAP |
| `webmail-compose` | control-plane, mail | Plain-text send through local Postfix submission |
| `reseller-center` | control-plane | List resellers and create one with a password and ACL flags |
| `dns-zone-manager`, `add-dns-zone`, `delete-dns-zone` | control-plane, pdns | List, add, edit and delete zones. Saving reconciles the zone to local PowerDNS |
| `backup-restoration` | control-plane, backups | Create an account archive in the local backup directory and restore it into that account home |
| `restart-web`, `restart-mysql`, `restart-mta`, `restart-imap`, `restart-ftp`, `restart-dns` | control-plane, systemd | Status and restart for Apache, MariaDB, Postfix, Dovecot, pure-ftpd and PowerDNS |
| `server-information` | control-plane, host-info | Load average, memory and the root filesystem |

Accounts, create-account, plans, domains, email, databases, files, and SSL status are separate pages so a missing binary hides only the page that needs it. Unimplemented catalog ids stayed on their own pages and remain unqualified.

Contact email writes the account and `idx_accounts` / search index. It does not call the host. A failed index write restores the previous address. Password replacement updates every login on that account and revokes its sessions. It does not call the host.

Terminate probes `GET /accounts/:user/purge`. Only `LinuxHostExecutor` answers `{ available: true, contract: "target-bound-userdel" }`. The API then marks the account terminating and `POST`s the same path. The agent runs `userdel -r` only when the username, uid (20000–60000), and home (`/home/<user>`) match that terminating account. If the home directory remains, state is kept and the API returns 503. A missing contract returns 412 and changes nothing.

## Not qualified

**Certificate files.** Keys, CSRs and uploaded certificate files stay on `/security/ssl/files` and are not an issuance flow. Wildcard names need DNS-01, which this client does not send.

**xMail beyond the inbox.** Reply, attachments, search, junk, quota and folders stay unqualified. The inbox lists, reads and deletes messages from the signed-in mailbox, and compose sends plain text. No sample messages are stored.

**The rest of the catalog.** About 593 tools remain researched until each one has an agent operation, an API route, a screen, and a probe on this allowlist.

## Lab

On 65.108.84.27, after this build is deployed and `xpanel-agent` plus the API are restarted:

1. Open xWHM as root and xPanel as `demohost`.
2. Groups whose probes passed are links. The others stay “Not yet available”.
3. Set `XPANEL_HOST_QUALIFICATION=off` to force the static catalog (nothing qualified).

Packages and services that change what appears:

- `useradd` (`/usr/sbin`) for suspend/terminate, and with Apache for create-account and domains
- `apache2` or `httpd` plus `apachectl` for account creation and domains
- `mariadb` or `mysql` client for databases
- `postfix` and `dovecot` for mailboxes. xMail signs in with the mailbox address. Dovecot must accept IMAP LOGIN on 127.0.0.1 port 143, and Postfix submission must accept AUTH PLAIN on 127.0.0.1 port 587. `XPANEL_IMAP_HOST`, `XPANEL_IMAP_PORT`, `XPANEL_SMTP_HOST` and `XPANEL_SMTP_PORT` override those defaults. `XPANEL_IMAP_TIMEOUT_MS` and `XPANEL_SMTP_TIMEOUT_MS` bound the connections
- `/opt/xpanel/bin/xpanel-account-files` present at agent start for the file manager
- no extra ACME package: the agent speaks HTTP-01 itself. The rendered nginx edge must answer port 80 and alias `/.well-known/acme-challenge/` to `/var/lib/xpanel/acme`. `/var/lib/xpanel` is mode 2770, so the installer grants nginx execute with `setfacl -m u:nginx:x /var/lib/xpanel` and the probe fails when nginx cannot read that directory. Apache stays the site engine behind that edge. A failed check is shown with the certificate authority's message. `sslinstall (SSL Host Installer)` and `AutoSSL` must stay enabled on the plan
- a primary shared IPv4 in the pool (`isPrimary`) so create-account can assign an address; `ip -j addr` only observes it
- feature lists that do not disable the keys named above
- `pdnsutil`, `pdns_control`, or `pdns_server` for the DNS zone editor. PowerDNS is already running on the lab; no extra package is required when one of those binaries is present
- `/var/lib/xpanel` present so the backup probe passes. The agent creates `/var/lib/xpanel/backups/<user>` mode `0700` and writes each archive mode `0600`. Optional override: `XPANEL_BACKUP_DIR`
- `/usr/bin/systemctl` for service status and restart. A unit that is not installed stays visible as “Not installed” and restart is refused
- readable `/proc/loadavg` and `/proc/meminfo`, plus `df`, for server information. The agent allowlist permits those two reads and the probe parses them
- GNU tar, including `--no-overwrite-dir`, for account restore

Terminate removes the Linux user and home. Run it only against an account you intend to delete. Account backup runs `tar` as that user, then the root agent copies the archive. Restore lists archive members first and refuses a path that starts with `/`, contains `..`, or contains a backslash. Archives larger than 2 GiB are refused.
