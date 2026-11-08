# Scheduler and host tools

Scope: server tasks, task chaining, event triggers, script library, webhooks, saved terminal commands, supervised daemons, service watchdog, PHP-FPM guardian, log cleanup, Linux tools, frp and server dynamic DNS.

## Choices

- **One scheduler file.** Tasks, scripts, triggers and hooks reference each other, so they share `extended/server/host-scheduler.json` and one validator. The other tools keep one file each under `extended/server/`.
- **A task is a systemd oneshot, plus a timer when it has a cycle.** Timers carry UTC in `OnCalendar=`, so a time zone change never moves a task. systemd refuses to start a running oneshot, so a slow run is not doubled.
- **No shell strings.** A command is an absolute binary and one argument per line, stored and installed as an argv. A shell or Python script is a root-only file passed to its interpreter as an argument. Nothing from a hook request reaches a script.
- **One small program runs a task.** `xpanel-host-task` reads a root-only JSON spec the generation wrote, runs its steps, bounds the log, records the run, checks the declared return type, prunes backups and starts triggered units, then exits. Triggers therefore need no polling: the run that produced the output evaluates them.
- **A failed run fires no trigger**, and a failed backup never counts toward retention, so a run of failures cannot push out good copies.
- **Triggers cannot loop.** A cycle is refused on save, because a trigger starts its target with no human in the way.
- **Writes that plant root commands need a signed-in panel session.** Tasks, scripts, triggers, hooks, daemons and saved commands refuse API tokens, like the root terminal. Reads and runs of saved items stay open to root tokens.
- **Hook keys are digests.** The key is shown once and can be rotated. It travels in the `X-Hook-Key` header, never in the URL, so no access log holds it. Unknown hooks and wrong keys answer the same 403. Hooks answer on the panel entry point over verified HTTPS only, as `/nic/update` does, and accept POST only, so a link preview cannot run one. 30 calls a minute per hook.
- **Daemons are units.** Supervisor would keep a Python process in memory to do what `Restart=` already does, so a daemon is one systemd service and the master profile holds the shared restart limits (same reasoning as decision 8).
- **Watchdog and guardian run on the agent's minute timer.** An unset watchdog costs two small file reads. Restarts use the reviewed path with its configuration test. The budget is per service per hour, and each restart doubles the wait before the next probe.
- **Pools expose `pm.status_path`.** Only a process that reaches the pool socket can ask; no site handler maps the name.
- **Log cleanup measures allocated blocks**, not file size, so the report matches what the filesystem gets back. Rotated names only, in fixed directories. Site logs are truncated in place, which keeps nginx's open file; metering already restarts its cursor on a shrunken log.
- **`/etc/hosts` stays in the generation.** One managed block is merged into the file the hostname step renders, so no drift appears.
- **Swap is `/var/swapfile` plus a `.swap` unit**, not an fstab edit. The unit is written outside the generation because the file must exist first; a host job creates the file and proves the size from `/proc/swaps`.
- **RAM disks are not restored on boot.** That is the behaviour the tool promises; the saved list offers Mount again.
- **Diagnostic tools are Software Center rows**, with its dry run and host job, not a second installer.
- **frp is one pinned release.** No distribution ships it, so the agent downloads a fixed version and refuses a digest mismatch. The client and server run under a dynamic user and receive the token as a systemd credential. A disabled side has no file, unit or open port. Upgrading frp is a code change with a new digest.
- **Dynamic DNS runs in the API process**, which owns zones and the reconcile path, on a one-minute check of a small file. A record is sent only when the address differs from the last accepted one, and a refused provider is retried on the next check. Credentials stay in a 0600 state file and never leave the API.

## Resource use

No new daemon. A run costs one short Node process capped at 48 MB of heap. Timers, watchdog, guardian and dynamic DNS cost nothing while unset. frp costs its own process only while enabled.

## Not built, with the reason

- PostgreSQL task backups: `pg_dump` runs as `postgres`, which cannot write the root-only copy directory.
- A run-as user for tasks: daemons have one; tasks stay root, as in cPanel's root crontab.
- Supervisor config files and frp raw config: desired state is the rendered file, so a raw edit would be overwritten.
- Automatic RAM disk mount at boot: see above.
