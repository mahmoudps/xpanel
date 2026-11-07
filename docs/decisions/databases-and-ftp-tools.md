# Databases and FTP tools

Choices for the WHM and owner database and FTP tools, with what was measured on a Ubuntu 22.04 host (Pure-FTPd
1.0.50, MariaDB 10.6, PostgreSQL 14, Linux 5.15), inside an unprivileged user namespace.

## FTP

- **One daemon.** Pure-FTPd only. FTP Server Selection is the "Run the FTP server" switch: off stops and disables the
  service and closes the passive ports. A second daemon would cost memory the 1 GB budget does not have.
- **Daemon files are part of every generation.** Nothing wrote them before, so a host kept the distribution defaults
  (PAM on, no PureDB link, no TLS). The Debian wrapper reads one file per directive plus numbered links in `auth/`;
  the EL package reads one `pure-ftpd.conf`. `pure-ftpd-wrapper --show-options` checks the Debian files before the
  restart; it refused a bad value and a missing PureDB file. Because of the second case the empty PureDB is now always
  built, which also drops the last deleted login from it.
- **TLS needs a certificate.** With TLS on and no certificate `pure-ftpd` exited 252 at start, so a self-signed
  certificate is created once, as cPanel starts from one. Replacing it belongs to the service certificate tool.
- **Restart only on change.** pure-ftpd has no reload, and a restart ends sessions on EL.
- **Anonymous FTP.** The catalog criterion is `anonymous@domain`, which works on shared addresses. The daemon's own
  anonymous mode serves one `ftp` user home (or one per IP through `/etc/pure-ftpd/pure-ftpd/<ip>`, and the host had no
  `ftp` user), so logins go through ExtAuth, after PureDB, to `pure-authd` and a short script over a root-owned map. The
  daemon and its unit run only while some account uses the feature. The Debian wrapper refuses an ExtAuth socket that
  does not exist (measured), so the unit waits for its socket and starts before pure-ftpd.
- **The jail cannot be swapped.** chroot(2) follows symlinks, and an account can replace `public_ftp` with a link to
  `/`. Sessions therefore enter through a bind mount of `/home` with `nosymfollow`: on the measured host a swapped
  `public_ftp` failed chroot with `ELOOP`. There is no window to race, no per-account mount and no change to the home.
  The mount needs Linux 5.10 and util-linux 2.36, which every supported profile has.
- **Read-only by mount.** The view is mounted `ro` unless uploads are on at both levels, so a server-level switch
  closes uploads at once without touching account directories. Sessions run as the overflow uid, so `incoming` needs
  mode 0733 and uploads are not charged to the account; `MaxDiskUsage 95` keeps the filesystem ceiling.

Not measured on a live login: pure-authd cannot change identity in a user namespace, so the sign-in chain itself waits
for native qualification. The script's protocol output, the wrapper, the view and chroot behaviour were measured.

## Databases

- **Database Map Tool.** The saved model holds database grants only, and reconciling a saved user removes what it does
  not list. A user with global grants, or grants outside the account, is refused before any change, so mapping never
  takes access away. The stored hash is read once for the saved user and reaches no browser, log or audit record.
- **Access hosts.** The push reuses the owner path account by account (lease, recovery, verification), so no second
  grant writer exists. A push stops starting accounts after 240 s and reports the rest; pushing again finishes them.
- **Tweak Settings: SQL.** Only keys with a consumer ship. `open_files_limit` 16384 and `max_allowed_packet` 256M are
  ceilings that cost no memory until used. The buffer pool is a quarter of memory in whole 128 MiB chunks, off by
  default because a 1 GB host needs the memory elsewhere.
- **Configure PostgreSQL.** Every role carries the account prefix, so the role cPanel names after the account is
  `<account>_owner`. It has a random password nobody knows until the owner sets one.
- **phpPgAdmin.** Sign-on follows phpMyAdmin: a single-use ticket, a reviewed bridge and a short-lived login. phpPgAdmin
  documents no sign-on method, so the bridge fills the session fields of its "shared credentials" login, checked against
  the 7.13.0 package. The login joins the owner roles of the account databases and each connection starts with
  `SET ROLE` to the owner of that database, set by `ALTER ROLE ... IN DATABASE`, so what it creates survives the login.
  `VALID UNTIL` closes it on time; the next sign-on drops it. The package exists on Ubuntu 22.04 (7.13.0) and 24.04
  (7.14.7) in universe. On 2026-11-07 it was absent from AppStream and CRB of AlmaLinux, Rocky and CentOS Stream, and
  from EPEL and Remi, for EL 9 and 10, so EL refuses with `no-distribution-package`. PGDG's common repository ships 7.13.0 for EL 9 and 10, but no profile
  enables it. `$conf['owned_only'] = true` is required: phpPgAdmin then lists a database only when the login holds its
  owner role, through `pg_has_role`. As with phpMyAdmin, the product does not install or serve the client: the package,
  bridge, configuration, ticket directory and web path are operator steps, and the page reports the first one missing.
- **Database server profiles.** See [dns-cluster-and-db-profiles.md](dns-cluster-and-db-profiles.md).

## Database services

Choices for the Redis, MongoDB and PostgreSQL service tools, database size limits and phpMyAdmin access.

- **No client packages.** The agent speaks RESP and OP_MSG with SCRAM-SHA-256 itself. `redis-cli` needs the password in
  argv or a child environment and one process per key; `mongosh` is a separate vendor package with a Node process per
  command. Neither fits 1 vCPU and 1 GB well, and a socket keeps the secret inside the agent. These costs were not measured.
- **Nothing runs until installed.** Reading a page starts no daemon. MongoDB comes from the vendor repository, which an
  operator adds; until then every route refuses with `mongodb_not_installed`. With no limit saved, the size tick runs no SQL.
- **A change is proved or undone.** Each file edit is written, activated and checked on the running daemon: PING for Redis,
  `getCmdLineOpts` for MongoDB, a query for PostgreSQL. A refusal puts the old file back and activates it again. PostgreSQL
  also checks `pg_hba_file_rules` and `postgres -C` first. `pg_file_settings` cannot judge `postgresql.conf`: it gives a valid
  value that waits for a restart and an invalid value the same text.
- **Remote access needs authentication first.** Redis refuses remote clients without a password and MongoDB refuses them
  without access control. The firewall stays the operator's decision.
- **PGPORT is the port seam.** Every product `psql` uses the libpq default, so the agent keeps the saved port in `PGPORT`
  for its query, script and tool runners.
- **Size limits keep DELETE and DROP.** A database over its limit loses every privilege that adds data, but its owner can
  still make room. The lock is written before the grants change, and the reconciler honours it.
- **A switch backs up, proves, changes, proves, or goes back.** Redis takes a BGSAVE, checks it with `redis-check-rdb`,
  downloads both versions so a rollback needs no network, then snapshots again right before the stop. It offers only
  versions the repositories hold, and refuses when the installed one has left them, because that switch could not be undone.
  PostgreSQL runs `pg_dumpall`, proves the dump ended, then uses `pg_upgradecluster` (Debian) or `postgresql-setup --upgrade`
  (EL). The old cluster stays stopped, so going back needs no restore. Major versions go upward only.
- **The data move keeps the original.** `cp -a`, `diff -r` over every file, then the server points at the copy. A failure
  points it back and removes the copy only after the original answers. The operator removes the old directory.
- **MongoDB import uses the panel's chunked upload.** The agent proves the gzip and the mongodump magic before the file
  joins the backups, and it refuses anything else. A restore stays a separate, confirmed step.
- **phpMyAdmin has its own server.** One nginx server and one `ondemand` PHP-FPM pool, so no worker runs while it is idle.
  The default ports 8008 and 8009 already carry `http_port_t` on EL. With public access off, other addresses get 403, and
  sign-on is not rendered because a browser could not reach it. The panel does not proxy the client.
