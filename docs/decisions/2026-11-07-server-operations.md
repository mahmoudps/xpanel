# Server, network and DNS operations

Scope: Change Hostname, Resolver Configuration, Add an A Entry for Hostname, Perform a DNS Cleanup, Domain Forwarding, Enable DKIM/SPF Globally, Tweak Settings: Domains, Nameserver and FTP Server Selection, cPanel Web Services Configuration, Edit System Mail Preferences, Server Profile, Configure cPanel Cron Jobs, Update Preferences.

## Choices

- **One desired-state file per tool** under `extended/server/`, revision-bound through `panel-config-file.ts`. A generation that a configuration test refuses restores the previous saved value, which is still running.
- **Resolvers leave the generation.** On Ubuntu `/etc/resolv.conf` is a symlink to the systemd-resolved stub, which the no-follow reader and the generation backup refuse. A reviewed agent route publishes a regular file over it, atomically, and reads it back. EL gets `dns=none` for NetworkManager first, because it would rewrite the file. A saved list is not re-applied by a reconcile; the page shows the saved list beside the observed one.
- **Roles are one state.** Server Profile and the DNS and FTP selection write `service-roles.json`. Decision 6: PowerDNS and Pure-FTPd only, each with a disable option. nginx is never a role unit, because it carries the management ingress on 2083, 2087 and 2096; the web role stops the site backends.
- **Roles that accounts use are refused** (`role_in_use`) for web, mail and databases. cPanel warns and goes ahead; stopping every hosted site from one form is not a safe default here, and a host with accounts has no profile to move to.
- **Activation is a host job**: one reviewed `systemctl enable|disable --now` step per installed unit, then a verification read and one reconcile. Disabled role units leave the compiled post actions, PowerDNS commands are dropped while DNS is off, and generations do not validate against a stopped PowerDNS.
- **Port 21 closes because nothing listens.** Firewall rules stay the operator's; a stopped daemon answers nothing.
- **Panel TLS** is one included file. `scripts/management-tls.mjs` writes the default once and keeps a saved policy; the reconciler renders the saved one, so nginx tests it before reload. The shared port 443 keeps the site edge policy: `ssl_protocols` there is chosen by the default server of the socket.
- **Domain forwards** take one pool address each and render one nginx server on port 80. Pool binding stays with the IP alias reconcile.
- **System mail** edits `/etc/aliases` in the generation with one managed block, like `/etc/hosts`, and runs `newaliases`.
- **`domains.docrootPublicHtml` starts off**, unlike cPanel: addon domains here live in `~/domains/<name>/public_html` by default and owners may already choose other roots.
- **Updater.** The signed release manifest names no tier and no remote feed exists, so a tier bounds how far an automatic update may move: long-term patches only, stable and release the same major, current and edge any newer. Security patches stay inside major.minor whatever the tier. A release comes only from verified staged releases, through the same route an operator uses, as the root principal who saved the preferences; a disabled owner stops the updater.

## Resource use

No new daemon. The updater runs on the agent's existing minute timer and reads two small files per tick. A disabled role frees its daemon's memory.

## Not built, with the reason

- Staging directory choice: the root lifecycle trusts one staging folder, and no release feed exists. Pushing preferences to cluster peers arrived later: see `2026-11-07-linked-servers.md`.
- Rewriting management TLS host names on a hostname change: the panel addresses move only through the Panel access binding, which keeps the old address open until the new one is confirmed.
- `disk-quota-setup`: `POST /api/server/quotas/init` belongs to another package.
