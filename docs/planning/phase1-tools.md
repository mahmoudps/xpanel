# Phase 1 tools

The live sidebars stay empty while every in-scope catalog tool is `researched`. This note records why, which tools now have a real path, and what the lab still has to install before a tool can appear.

## How a tool becomes visible

`packages/catalog/src/data/delivery.ts` ships `deliveryEvidence = []` and `deliveryTarget = null`. `assessDelivery` therefore marks every in-scope tool `researched`. Production catalog tests keep that static result: nothing in the shipped catalog is `verified`.

`isVisible` (`packages/catalog/src/visibility.ts`) shows a tool only when both `tool.status` and `tool.delivery.status` are `verified`, the surface matches, and root, reseller ACL, and feature-list rules pass. `visibleNavigation` then keeps a page only when **every** tool on that page is visible. The home shell renders those pages as links. Every other catalog group stays a disabled row labelled “Not yet available”.

Stuffing synthetic `CapabilityEvidence` into the static catalog would mark tools verified on every install, including ones this host cannot run. That is not the gate.

## Runtime qualification

`qualifyHostTools` copies the catalog and marks a tool verified only when all of the following are true:

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
| `acme` | The in-repo HTTP-01 client is built into the Linux agent. `certbot`, `lego`, or `acme.sh` also pass the probe. Issuance uses the in-repo client |

`test:linux` remains the host qualification harness for executor behaviour. It does not flip the static catalog. A lab host qualifies tools by running the real agent and API; no separate evidence file is required.

## Tools that qualify

A page is hidden until every tool on it qualifies. Feature keys must not be in the plan’s disabled list (`domains` and `addondomains`, `popaccts (Email Accounts)`, `mysql`, `filemanager`, `AutoSSL`).

| Tool | Probes | What works |
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

Accounts, create-account, plans, domains, email, databases, files, and SSL status are separate pages so a missing binary hides only the page that needs it. Unimplemented catalog ids stayed on their own pages and remain unqualified.

Contact email writes the account and `idx_accounts` / search index. It does not call the host. A failed index write restores the previous address. Password replacement updates every login on that account and revokes its sessions. It does not call the host.

Terminate probes `GET /accounts/:user/purge`. Only `LinuxHostExecutor` answers `{ available: true, contract: "target-bound-userdel" }`. The API then marks the account terminating and `POST`s the same path. The agent runs `userdel -r` only when the username, uid (20000–60000), and home (`/home/<user>`) match that terminating account. If the home directory remains, state is kept and the API returns 503. A missing contract returns 412 and changes nothing.

## Not qualified

**Certificate files.** Keys, CSRs and uploaded certificate files stay on `/security/ssl/files` and are not an issuance flow. Wildcard names need DNS-01, which this client does not send.

**xMail inbox.** Panel and xMail sign-in is the hosting account, not a mailbox. Mailbox passwords are the service-user secrets used by Postfix and Dovecot. Reading an inbox needs a mailbox-scoped IMAP or `doveadm` reader, and that reader is not connected. Inbox, folders, and compose stay unqualified. No sample messages are shown.

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
- `postfix` and `dovecot` for mailboxes
- `/opt/xpanel/bin/xpanel-account-files` present at agent start for the file manager
- no extra ACME package: the agent speaks HTTP-01 itself. The rendered nginx edge must answer port 80 and alias `/.well-known/acme-challenge/` to `/var/lib/xpanel/acme`. Apache stays the site engine behind that edge. A failed check is shown with the certificate authority's message. `sslinstall (SSL Host Installer)` and `AutoSSL` must stay enabled on the plan
- a primary shared IPv4 in the pool (`isPrimary`) so create-account can assign an address; `ip -j addr` only observes it
- feature lists that do not disable the keys named above

Terminate removes the Linux user and home. Run it only against an account you intend to delete.
