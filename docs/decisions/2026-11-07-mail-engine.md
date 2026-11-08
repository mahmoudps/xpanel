# Mail server and xMail engine tools

Date: 2026-11-07. Scope: Wave 5 mail tools, including the Exim Configuration Manager equivalent for Postfix.

## Decisions

- Mailbox format: maildir only (owner decision 7). No mdbox conversion exists, because quota, backup, restore, the mailbox repair job and spam training all read maildir paths.
- Configuration manager: desired state stays in `extended/mailx/*.json`. A backup is a copy of those sections with a fingerprint of what they generate, so restore is byte-identical by construction. Reset rewrites saved sections with defaults instead of removing them, because a removed section is no longer managed and its files and port 25 certificate would stay on the host. Keys a change stops setting are removed with `postconf -X`, which returns them to the Postfix default.
- Advanced options: any `main.cf` parameter of the running Postfix release except keys another section or the reconciler owns, and keys that run programs, choose delivery transports or move Postfix directories and identities.
- Country filter: a `cidr:` table in `smtpd_client_restrictions` after trusted clients, as cPanel uses a per-country range file. It needs no daemon, and it applies, tests and rolls back with the other mail tables. The table is built from the GeoIP database by one tree walk at apply time. `cidr_table(5)` loads into each smtpd and scans in order, so a filter above 200,000 networks is refused.
- GeoIP: built against the source on `temp/w4-stats` (`createGeoipSource`, `lookupGeoipCountry`, `readGeoipMetadata`) through `MailxGeoipPort`. Until that branch is merged the port is null, and the filter refuses with `geoip_unavailable`. After the merge, pass the port as `geoip` in the agent's mail policy route context and read the status there.
- spamd startup: a systemd drop-in adds a second `EnvironmentFile` that replaces `OPTIONS` (Debian family) and `SPAMDOPTIONS` (EL family), so no distribution file is edited. rspamd has no equivalent of the allowed addresses or the TCP timeout, so it takes only the worker count, tasks per worker and task timeout.
- Greylisting per domain: an rspamd settings rule with a negative greylist action greylists every unknown triplet for that recipient domain. rspamd applies one settings rule per message, so a mailbox score rule repeats the action. SpamAssassin has no greylisting, and the page says so.
- Email routing `auto`: detected once from the saved zone at save time, as cPanel does, and stored with `auto: true`; it does not follow later MX changes.
- Search index: `fts-xapian` through `doveadm fts rescan` and `doveadm index`, indexed on search rather than on delivery, so mail flow on a small server carries no indexing work. The Dovecot file is rendered only when the plugin library exists, because Dovecot refuses a configuration that names a missing plugin.
- Spam marking: a message moves first, then one sample is read by UID and taught to the running filter from a root-only temporary file. A training failure is reported beside the completed move.
- Spam auto-delete: Sieve `discard` on the star count of `X-Spam-Level`. SpamAssassin adds that header by default; rspamd adds it through its `milter_headers` routine, which the policy writes when a mailbox uses the threshold.
- View Sent Summary limits are reporting thresholds. Postfix has no per-domain hourly cap, so they flag a domain and do not stop mail.
- Mail repair: ownership runs as root with `find -execdir` and `chown -h`, on directories and single-link files only, so a tenant cannot redirect it with a symlink or a hard link. Modes then run as the account, because `chmod` follows symlinks.

## Measurements

None on a host. No mail daemon was run for these tools: Postfix, Dovecot, rspamd and SpamAssassin behaviour above comes from their documentation and is unit-tested only as rendered text and argv.

## Open

- Native proof on every profile: `cidr:` table size and smtpd memory on 1 GB, rspamd negative greylist action, `milter_headers` output, `fts-xapian` parameters, spamd drop-in.
- `dovecot-fts-xapian` is listed for Ubuntu 22.04 and 24.04, confirmed in the Ubuntu archive. No enabled EL repository ships it, so `scripts/el-source-builds.sh` builds upstream 1.9.3 from Debian's orig tarball, pinned by SHA-256, on EL only and only with mail. Its `dovecot-devel` and `xapian-core-devel` come from CRB. Measured on 2026-11-07 in AlmaLinux 9.8 (Dovecot 2.3.16, GCC 11.5) and 10.2 (Dovecot 2.3.21, GCC 14.3) userspaces under an Ubuntu kernel: the installer function built the plugin in about 16 s at 275 MB peak RSS, and `doveadm fts rescan`, `index` and `search` found a message with the rendered settings. Not run: a real EL host, SELinux enforcing, the agent's job. A Dovecot rebase is handled in `2026-11-07-el-source-rebuild.md`.
- Debian's package depends on the Dovecot ABI, and the EL build does not. A `dnf` update that rebases Dovecot to another upstream version leaves a plugin that Dovecot refuses to load, so that update needs the build run again.
- SpamAssassin training runs `sa-learn` as root, like the existing folder training job, and xPanel sets no shared `bayes_path`. Samples may therefore reach root's own Bayes store instead of the one the scanner reads. rspamd is not affected. Confirm on a SpamAssassin host before relying on it.
- `.xlsx` is not read: the importer takes `.xls` and CSV. Bulk junk marking acts on the open page, and a domain limit holds its mail through the outbound hold, counted from the log each minute.

## SpamAssassin training

`sa-learn` writes the store of the user it runs as, so training as root missed the store the scanner reads. spamd takes the user its client names, which is the spamass-milter account, so training runs as the scanner account whose home holds `.spamassassin/bayes_toks`, else the first scanner account on the host. It keeps `CAP_DAC_READ_SEARCH` alone, because that user cannot read account mail or the root-only sample. Not measured on a host.
