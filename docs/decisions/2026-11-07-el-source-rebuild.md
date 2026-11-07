# EL source builds after a distribution update

Date: 2026-11-07. Scope: the modules EL repositories lack, built from pinned source: Apache mpm-itk (owner decision 2026-11-02), Webalizer and AWStats (decision 12 of 2026-11-07), `dovecot-fts-xapian` (follow-up 6).

No package dependency protects these files, so `dnf` can move what they were built against and nothing notices. A distribution update must never silently break a product feature.

## What breaks, and how

| Module | Bound to | What a rebase does | Detection |
|---|---|---|---|
| `dovecot-fts-xapian` | Dovecot ABI string, which carries the upstream version | Dovecot refuses a plugin of another ABI, and `mail_plugins` makes that fatal: every login fails, and LMTP defers delivery | Installed `dovecot` VERSION against the recorded one |
| mpm-itk | httpd API | The module magic number stays the same across 2.4, so the old module normally keeps loading; a real incompatibility stops Apache on its next start | Installed `httpd` VERSION against the recorded one |
| Webalizer | Shared libraries (`gd`, `libpng`, `zlib`) | A changed soname stops it loading; no version to compare | `webalizer -V` |
| AWStats (EL 10) | Perl modules | A dropped module stops it loading; no version to compare | `perl -c` |

VERSION, not RELEASE: a rebase changes the upstream version, and a security RELEASE keeps the ABI. Rebuilding on every RELEASE would cost a compile, and turn search off, for a change that needs neither.

## Mechanism

- **Record.** `scripts/el-source-builds.sh` holds the pins and builds, sourced by `install.sh`, so install and rebuild are one code path. Each build writes `/var/lib/xpanel/source-builds/<module>` with the package version (empty for Webalizer and AWStats). No record means the host never built that module, so it has no row.
- **Trigger.** The dnf post-transaction-actions plugin, already a bootstrap package for Compiler Access. `xpanel-source-builds.action` touches a marker for `httpd*`, `dovecot*`, `gd*`, `libpng*`, `zlib*` and `perl*`. The agent's existing minute timer reads the marker. The agent also checks at start and every 6 hours, which covers `rpm -U`, `--noplugins` and a removed plugin, and paces retries. The reconciler renders the hook only while the plugin is installed, by the same proof as Compiler Access.
- **Rebuild.** One module at a time, in the transient unit `xpanel-source-build`: `Nice=19`, idle I/O, `CPUQuota=50%`, `MemoryMax=512M` (the plugin build peaked at 275 MB), `OOMScoreAdjust=1000`, `RuntimeMaxSec=1800`. A fetch, digest or build failure leaves the live file in place, because each build lands beside it as `<file>.new`.
- **Headers.** The build refuses when `httpd-devel` or `dovecot-devel` is behind the installed package: it would build the old ABI and record the new version.

## Keeping services up

- **Dovecot.** A stale plugin refuses logins, so the agent removes it and reconciles first: `96-xpanel-fts.conf` is rendered only when the plugin exists, so Dovecot reloads without it and mail works without search. A successful build restores both. A failed one leaves mail running, and webmail reports search as not configured (`fts_not_configured`).
- **Apache.** mpm-itk is the account isolation model, so it is never removed, and prefork alone is never a fallback. The new module replaces the old only if `httpd -t` accepts it; otherwise the old one returns. A graceful reload then loads it, and a unit that had failed is restarted.

## State

`GET /api/server/services/source-builds` (`xwhmapi server services_source_builds`, Panel settings page, both themes) lists each module as `current`, `stale`, `rebuilding` or `rebuild_failed`, with the versions and the last failure time. An unreadable package database refuses with `package_versions_unreadable` instead of calling everything stale. Each attempt writes the audit entry `server.source_build.rebuild`; its result is in the journal of the unit.

## Rejected

- Polling `rpm -q` from the minute timer: a timer can see a transaction half done (package updated, headers not yet) and start a build on the old headers. The hook runs after the transaction.
- The build inside the hook: it would hold dnf for minutes.
- A hook that rewrites Dovecot itself: the configuration is rendered, so the agent owns it.
- `version_ignore=yes` in Dovecot: loads a plugin of another ABI, which can crash mail processes.
- Rebuilding at RELEASE changes: see above.
- `dnf versionlock`: blocks security updates.

## Limits

- Between the dnf restart of Dovecot and the agent's reaction (up to a minute, plus a reconcile), a real ABI change refuses IMAP logins. LMTP defers, so no mail is lost.
- A failed mpm-itk rebuild leaves the old module. If Apache truly cannot load it, Apache stays down, nginx answers 502 and the state says so. Serving accounts without isolation is not an option.
- Rebuilds fetch from the Debian archive. A host that is offline, or a pin Debian has dropped, stays `rebuild_failed` until the fetch works or a release moves the pin.
- A moved pin alone does not trigger a rebuild; the versions must differ. An installer re-run applies it.
- An agent restart during a build refuses a second run until the first ends; the state corrects itself once the record matches, but restoring search then waits for the next reconcile.
- Libraries the plugin links (`xapian-core-libs`, `libicu`) are not checked: EL keeps their sonames within a major release.

## What only a native EL run proves

Not run on any EL host. Tests use doubles for rpm, systemd, the network and the compilers.

- The hook firing from `dnf` and from `dnf-automatic`, including under SELinux enforcing.
- `systemd-run` with these properties on systemd 252 and 257, and the build finishing inside them on 1 vCPU / 1 GB.
- The `rpm -q` line on a host where `dovecot` is missing (the `package ... is not installed` sentence).
- Dovecot's refusal of a plugin of another ABI, and logins recovering once `96-xpanel-fts.conf` is gone.
- The graceful reload loading a replaced `mpm_itk.so` with account identity intact.
- SELinux labels of the replaced files in `/usr/lib64/httpd/modules`, `/usr/lib64/dovecot`, `/usr/bin` and the AWStats tree.
