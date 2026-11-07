# Packages of a release on an upgraded host (2026-11-07)

A release can declare packages the host it upgrades never received: the Web Disk server, the Radicale library, AWStats, Webalizer, the GeoIP2 Perl module, the search index plugin. The installer is the only code that used to install them, and it refuses a host that already runs the panel.

## Decision

The upgrade itself never touches a package manager. A package manager can take minutes, can hang on a mirror and can restart services, and the upgrade machine holds lifecycle admission while its health gate decides whether to roll back. So nothing about packages can fail a health gate or hold a barrier.

After settlement, the agent restarts on the new release outside the barrier. The first tick of its existing minute timer compares the declared set with the package database and queues one host job, `system.packages.release:<version>`. The job kind carries the version, so the finished job is the record of the attempt and no second state file exists. The tick waits while another package manager runs. It holds writer admission only while it queues, and the job runs outside it, as every host job does. A running job counts as active work, so preflight refuses the next upgrade until it ends.

The declared set is `releaseFeatures()` in `packages/os`, built from the same profile roles as `installPlan()`. A test compares the two for every supported OS, and an older test compares `installPlan()` with `install.sh`. The install choices are not stored, so an optional feature counts as chosen when its own main package is present. `postfix` alone proves nothing, because some images ship it.

Each feature installs in its own transaction, so a package a repository lacks costs that feature only. The steps tolerate apt's exit 100 and dnf's exit 1 for that reason, and the job's outcome comes from re-reading the package database. The report on the upgrade page is always read live, per feature. A failed job stays failed: a later agent restart does not repeat it, and the root operator retries from the page or with `xwhmapi server upgrade_packages_retry`.

## What a package needs beyond its install

- Webalizer on EL, AWStats on EL 10 and the search index plugin on EL come from pinned sources. The job runs the same functions of `install.sh` through `--el-source-build`, which does nothing else.
- lighttpd starts a distribution daemon. The job stops and disables it, as the installer does.
- The awstats RPM on EL 9 brings a stock site that admits `Require local`, and behind the nginx edge every visitor is local. The agent writes the installer's empty managed file before the job and again when it settles.
- A compile reads which optional modules exist, so the job ends with a reconcile.

## Pre-switch canary

An OS package update can restart nginx or a pool during the held exchange of the pre-switch canary. That exchange now runs once more when the first failure was a connection reset and cleanup closed everything it opened. It waits 5 seconds, repeats the guard, and uses the same binding with a new challenge, inside the same 60 second observation deadline. Every other failure keeps its refusal. Closed recovery holds a worker pin and does not retry.
