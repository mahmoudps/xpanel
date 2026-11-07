# Web Disk (WebDAV) and calendars and contacts (CalDAV/CardDAV)

Date: 2026-11-07. Scope: the xPanel Web Disk tool, the CalDAV/CardDAV server behind Calendars and Contacts, their credentials, isolation, quotas, TLS and client setup. Owner decision 10: study the options within 1 vCPU / 1 GB, choose, implement.

## Decision

- **WebDAV: lighttpd with mod_webdav**, one instance per Web Disk login, running as the account. Packages: Ubuntu `lighttpd` and `lighttpd-mod-webdav` (universe), EL `lighttpd` and `lighttpd-mod_webdav` (EPEL). The distribution `lighttpd.service` is stopped and disabled by the installer.
- **CalDAV/CardDAV: Radicale**, one instance per account, running as the account, loaded by a stdlib launcher on its systemd socket. Packages: Ubuntu `python3-radicale` (universe), EL `python3-radicale3` (EPEL). Only the library is installed; the distribution daemon package (`radicale` / `radicale3`) is not.
- **TLS and authentication at the existing nginx edge**, on the cPanel ports: Web Disk `https://<domain>:2078/`, calendars and contacts `https://<domain>:2080/`, each with the domain's own installed certificate. Plain-text 2077/2079 are not offered. nginx asks the panel API (`auth_request` to `GET /api/dav/authorize` on the xPanel listener, through the management ingress credential) and forwards only the identity the API returns.
- **Credentials as on cPanel.** Web Disk: the account username with the account password (main Web Disk account, whole home, read-write) and every User Manager user with Web Disk enabled (its own directory, read-write or read-only). Calendars and contacts: the account username with the account password, and every mailbox with its mailbox password. Two-factor authentication keeps protecting the panel and xMail sign-in only, as for IMAP/SMTP (owner decision D5); there are no app passwords. Basic authentication over TLS only.
- **No Digest, checked against cPanel parity.** cPanel keeps Digest as a Web Disk option, off by default, for Windows clients that refuse Basic on a plain connection. Port 2078 has no plain connection, and Windows accepts Basic over TLS. Digest would also store a password-equivalent secret (the MD5 of user, realm and password) for every login beside the Argon2id hash, so a leaked state file would be enough to sign in. It is not offered.
- **Isolation.** Every DAV process runs as the account in its own slice, mount namespace and the hardening of the account units (`packages/render/src/system/units.ts`). A Web Disk user's namespace shows only its own directory, read-only bind for a read-only user, so a symlink cannot lead out of it. nginx reaches the processes only through root-owned sockets of group nginx (mode 0660); no DAV process listens on TCP.
- **Quotas.** Files and calendar data are written as the account inside its home (`~/.caldav` for Radicale, as cPanel), so the account's disk quota and its slice limits apply; a write over quota fails at the kernel.
- **On demand.** Nothing runs while no client is connected. lighttpd sits behind `systemd-socket-proxyd --exit-idle-time=10min` with `StopWhenUnneeded`; Radicale's launcher exits after 60 s without a request. systemd starts both again on the next connection.

## Measurements

Ubuntu 22.04 qualification guest (6 vCPU, 12 GB), unprivileged user, the distribution packages unpacked from the archive (lighttpd 1.4.63, Radicale 3.0.6, nginx 1.18.0), services started by `systemd-socket-activate` on unix sockets. CPU is user+sys of the server process; on a 1 vCPU host wall time is at least that. RSS counts shared libraries; PSS is the process's own share.

| Measurement | lighttpd mod_webdav | Radicale 3.0.6 + launcher |
|---|---|---|
| Cold start to first response | 0.036-0.066 s | 0.26-0.28 s (Python import 0.20-0.28 s, 26 MB) |
| Idle after start | RSS 6.3 MB, PSS 1.9 MB | RSS 28.4 MB, PSS 23.5 MB |
| Writes | 200 PUT of 4 KiB: 0.06 s CPU | 200 vCard PUT: 2.8-3.2 s CPU (14-16 ms each) |
| Reads | 50 PROPFIND depth 1 over 200 entries: 0.33 s CPU | 20 REPORT with address data over 200 cards: 0.5 s CPU |
| Peak after the run | RSS 10.6 MB, PSS 6.0 MB | RSS 28.9 MB, PSS 24.0 MB |
| Large body | 64 MiB PUT streamed to the destination; upload directory peak 4 KiB; RSS unchanged | n/a |
| Protocol | MOVE, COPY, MKCOL, LOCK/UNLOCK (423 without token), PROPPATCH, DELETE; read-only instance refuses PUT, DELETE, MKCOL with 403 | MKCALENDAR, event and vCard PUT; default calendar and address book created on first request; DELETE of a default collection 403; another principal 403; missing or malformed identity 403 |
| Idle exit | via the socket proxy | exits after the configured idle time (verified at 20 s) |

nginx 1.18 edge with `auth_request` (also compiled into the EL 9 nginx 1.20.1 and EL 10 nginx 1.26.3 packages): 401 carries the API's `WWW-Authenticate`; a client `X-Remote-User` is replaced by the verified identity (a forged identity reached only the caller's own principal, 403 elsewhere); a variable unix-socket upstream works; a chunked PUT streams through with request buffering off; MOVE/COPY need `proxy_set_header Host $http_host` (502 from lighttpd otherwise, because the Destination host must match). Worker RSS 3.0 MB, PSS 1.1 MB.

Installed sizes (Ubuntu 22.04, KiB): lighttpd 1266, lighttpd-mod-webdav 84, python3-radicale 386 with python3-vobject 191, python3-defusedxml 110, python3-dateutil 322 and python3-passlib 2047.

Package availability (repository indexes, 2026-11-07): Ubuntu 22.04 lighttpd 1.4.63, Radicale 3.0.6; Ubuntu 24.04 lighttpd 1.4.74, Radicale 3.1.8; EPEL 9 lighttpd 1.4.67, python3-radicale3 3.9.0; EPEL 10 lighttpd 1.4.76, python3-radicale3 3.9.0.

## Budget on 1 vCPU / 1 GB

Idle cost is zero processes. An active Web Disk login costs about 2-6 MB PSS (plus about 1 MB for its socket proxy) for up to 10 minutes after its last connection. A calendar sync costs one 0.3 s cold start and about 24 MB PSS for 60 s after its last request: 50 accounts whose devices sync every 15 minutes average about 50 x 24 MB x 1/15 = 80 MB. Password verification is Argon2id (64 MiB, one derivation at a time); the API caches a successful verification for 5 minutes, bound to the stored hash, so a sync burst costs one derivation. Failures count toward the shared sign-in lockout.

## Rejected

- **Apache mod_dav under mpm-itk** (already installed, no idle cost): the Apache backend listens on loopback TCP that every tenant process can reach, so an edge-verified identity would need a per-request shared secret; Apache cannot verify the Argon2id service hashes; mod_dav's Destination check needs rewriting behind the proxy; every request forks an itk child.
- **nginx dav and dav-ext** (the previous unwired `renderWebDiskConfig`): runs as the nginx user, so files would belong to nginx and every account's home would be readable by one process; dav-ext is not packaged on EL; no per-user directory or read-only right.
- **rclone serve webdav**: Ubuntu 22.04 ships 1.53 without socket activation; a Go process of about 30 MB per login.
- **Xandikos**: not in EPEL 9. **DAViCal**: PostgreSQL schema, Ubuntu only. **Baikal/SabreDAV**: not packaged on all profiles. **SOGo, Cyrus**: far over budget.

## One store

As on cPanel, webmail and devices share one store. xMail's calendars, contacts, contact groups, address books and task lists are Radicale items and collections in the account's `~/.caldav`, so an event made in xMail reaches a phone on its next sync and the reverse. There is no second copy in panel state; the panel keeps only which collection is the default.

- **Writes** go through Radicale as the mailbox, over `POST /accounts/:username/dav-exchange` on the root agent, which opens the account's socket and names the identity as nginx does for a device. `If-Match` guards an edit, so a change made on a phone since the read comes back as a conflict. A rewrite touches only the changed fields: alarms, attendees and repeat rules stay.
- **Reads** come from the launcher's `GET /.xpanel/store`, a file view that does not import Radicale. nginx refuses `/.xpanel/` on port 2080: the view holds whole shared collections and is the agent's alone.
- **Identity.** Collections are keyed by the mailbox's service user id (`main` for the account login), never by its address. Every path that removes a mailbox (mailbox, domain or account removal) drops that id from desired state, and the next reconcile prunes its tree as the account. A new owner of the address has a new id and an empty tree. A transfer keeps the id.
- **Sharing** is kept as collection properties with a grantee list the launcher reads; the API then keeps only the records shared with that mailbox. A store write for a shared collection runs as its owner, after the API has checked the share.
- **Locks.** Panel writes to one mailbox run one at a time on a per-mailbox lock; a slow tenant store does not hold the shared state lease.

Measured on the guest with Radicale 3.0.6:

| Step | Time | Memory |
|---|---|---|
| Cold store read, launcher only | 0.066 s | RSS 18 MB, PSS 13 MB |
| First write, Radicale loaded | 0.25 s | RSS 31.7 MB, PSS 26.6 MB |
| 50 PUTs through Radicale | 1.69 s | |
| Store read of 51 items | 0.01 s | |

## Panel pages

The Web Disk page lists the main login and the Web Disk users, adds, changes and removes them through the service user routes and reads each change back; removing Web Disk from a login with email or FTP keeps that login. The account's Calendars and contacts page lists every login with its server, principal and collection URLs, and the xMail calendar settings show the signed-in mailbox's own. Both pages give setup steps for the common clients.

## Device discovery and profiles

- nginx answers `/.well-known/caldav` and `/.well-known/carddav` on port 2080 with a redirect to the root, where Radicale reports the signed-in principal (RFC 6764). Each website answers the same paths with a redirect to its first name served on port 2080.
- Zones hosted here carry `_caldavs._tcp` and `_carddavs._tcp` SRV records with a `path=/` TXT record for each served domain. They are rendered with the zone and never saved in it, as the DKIM additions are: they follow the certificate, the plan, the account state and the management ingress, and a service record the owner already published stays. Plain `_caldav` and `_carddav` are not published, because no plain port exists.
- Each login has an Apple profile (`com.apple.caldav.account` and `com.apple.carddav.account`) with its server, principal and username. It holds no password, and it is unsigned, so the device reports it as unverified. Android has no profile format: DAVx5 discovers the server from the email address or takes the principal URL.

## Limits

- A missing Web Disk directory is created as the account at each reconcile. One that cannot be created, because a file holds the path or the quota is full, leaves that login unavailable and does not stop the reconcile.
- lighttpd keeps locks and custom WebDAV properties in its runtime directory, so they last while the login's session is active.
- Downloadable Web Disk client scripts are not provided; the pages give manual steps.
- Turning email off for a login retires its mailbox, so its calendars and contacts are deleted at the next reconcile.
- A share made in xMail applies in xMail. A device signed in as the other mailbox sees its own collections only.
- A repeating event shows its first date in xMail and keeps its rule. A task, or a card that cannot be parsed or is over 1 MiB, stays in the store and xMail leaves it out. Quoted-printable and base64 fields of a vCard 2.1 card are read in their character set, and an edited field is written as plain UTF-8.
- The launcher serves the store in pages of 6 MiB, the agent's transport bound, and the API holds 16 MiB per request at most. A store beyond that, or an item no page can hold, is refused with `dav_store_too_large` for reads and writes alike, and the pages say so: xMail never shows part of a store as complete, and no write starts from part of one. Devices keep the whole store. One such mailbox also refuses the account overview, which reads every mailbox one at a time.
- The firewall must admit TCP 2078 and 2080: new installations seed both rules; an existing rule list is not changed automatically.
- Not yet qualified: native runs on Ubuntu 24.04 and EL 9/10 (Radicale 3.9 on EL in particular), real Windows, macOS, iOS, Thunderbird and DAVx5 clients, and a quota-full write on a real quota filesystem.
