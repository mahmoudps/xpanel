# Release retention: the product removes old installed releases

Date: 2026-11-09.

## Problem

Nothing removed an installed release. Every upgrade left the previous tree under `/opt/xpanel/releases/`, its prepared records under `/var/lib/xpanel-lifecycle/prepared/` and its extraction leftovers under `/opt/xpanel/staging/`. The production host keeps 0.1.23, 0.1.32 and 0.1.33 beside current 0.1.43 and previous 0.1.42. Hand edits of `/opt/xpanel` are not allowed, so removal must be a product operation with the same safety as the rest of the native lifecycle.

## Decision

`scripts/release-retention.mjs` decides which releases stay and is the only code that removes the others.

### Keep rule

A release stays for every reason that names it. The reasons come from protected records and live references only:

- `current`: the release `/opt/xpanel/current` points at. The installation receipt and `bootstrap.json` must name the same version, and the transition journal that `bootstrap.json` names must have published that side. Any disagreement refuses.
- `previous`: the rollback target, the `previousTarget` of every published installation transition that selected the current release as its target.
- `transition`: both sides of an installation transition that is not published.
- `coordinator`: the helper release of `coordinator.json`.
- `prepared`: a complete prepared record for a release newer than current (acquired, not yet installed).
- `preparation-open`: a prepared record with only its intent (an acquisition in progress or interrupted).
- `unit`: any file in `/etc/systemd/system`, `/run/systemd/system` or `/run/systemd/transient` (and their `.d` drop-ins) that names `/opt/xpanel/releases/<version>`, so `ExecStart` and `WorkingDirectory` both count.
- `process`: the working directory, executable or arguments of a live process.

Everything else is removable: release directories, prepared records and `version-` markers of removed versions, and staging entries. A staging entry stays while any preparation is open, and for 15 minutes after its last change, because an acquisition extracts into staging seconds before its prepared intent exists.

The prune refuses before any effect when the writer barrier exists, `HEAD` is not `idle` or `retired`, or a coordinator rotation journal is not `complete` or `rolled_back` (`RELEASE_RETENTION_OPERATION_OPEN`). Admission, recovery and operator-request records belong to an operation that holds the barrier or `HEAD`, so this check covers them.

### Safety

- Root only (`RELEASE_RETENTION_ROOT_REQUIRED`).
- Every directory a record or target is read through is a real directory that only root can change (`RELEASE_RETENTION_ANCESTRY_UNSAFE`). Records are root-owned single-link regular files, opened without following links; an unreadable or malformed record refuses (`RELEASE_RETENTION_RECORD_UNVERIFIED`).
- A target is a real directory with a version-shaped (or fixed-shape) name directly under its root, root-owned, on the same filesystem as its parent, not a mount point and with no mount below it, not the same inode as a kept release, and every entry below it is root-owned, on the same filesystem, not writable by others, and a directory, regular file or symbolic link (`RELEASE_RETENTION_TARGET_UNSAFE`). A hard-linked root file is allowed: pnpm links dependency files from its store, and unlinking a name never changes the shared inode. A file owned by another user is refused, because it could be someone else's data linked into the tree.
- Under the lifecycle writer lock (exclusive), the plan is observed again. A target that became live since the first look stays; a target whose inode changed refuses (`RELEASE_RETENTION_TARGET_CHANGED`). A durable record `/var/lib/xpanel-lifecycle/release-retention/<operation>.json` (`quarantining`) is written first, each target is renamed into `/opt/xpanel/.retention-<operation>/` (or `/var/lib/xpanel-lifecycle/.retention-<operation>/` for prepared records) on the same filesystem, and the record moves to `quarantined`. The lock is released before deletion, so panel writers wait only for the renames.
- Deletion removes each quarantined tree only when it still has its recorded inode, then marks the record `complete` with the removed list.
- A run first resumes every record that is not `complete`: it deletes what was quarantined and leaves a target that was never moved for the new plan. A record whose owner process (pid, start time, boot) still runs refuses as `RELEASE_RETENTION_BUSY`, as does a held writer lock. A quarantine whose inode differs refuses as `RELEASE_RETENTION_RESUME_UNCERTAIN`. Record paths are checked against the paths the module derives, so a record cannot direct deletion anywhere else.

The current release, the rollback target, account data and state are never targets.

### When it runs

- Automatically after a native upgrade settles successfully: in the root operator after its native admission closes, and in the WHM handoff path after the handoff returns committed. It never runs after a refused, failed or rolled-back upgrade or a recovery. A refusal is written to the journal (`xpanel-release-retention: upgrade prune withheld code=...`) and never changes the upgrade result.
- By the operator: `xpanel-ctl releases prune` removes; `xpanel-ctl releases prune --dry-run` lists each removal and the reasons for each kept release, and removes nothing. `--json` gives the same result as one object. Output names kinds, versions and record names, never host paths.

### Audit

Each removal writes a journal line (`xpanel-release-retention: removed kind=... name=... operation=... trigger=...`), and the root-only retention record keeps the full plan, every target with its inode, and the removed list. The panel audit log is not written: the operator command and the coordinator run as root outside a database admission, and a root process must not open the panel database to append to it.

## Not done

The WHM upgrade page is the matching surface for a read-only list of installed releases with their retention reasons. It is not added in this change: it needs the agent observation, both themes, translations and page checks, and is a follow-up.

Lab upgrades run their steps as transient units with `RemainAfterExit=yes`. Until such a unit is stopped, its file names the release it ran from, so that release stays with the reason `unit`.
