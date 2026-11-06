# Account termination point of no return

Date: 2026-11-06. Scope: the reconciler's terminate plan (`apps/agent/src/reconciler.ts`), the API purge (`DELETE /api/accounts/<id>`) and account provisioning replay.

## Problem

The terminate plan ran `userdel` and the home removal among the generation's post-actions, before the health probes and the DNS observation. When a later check failed, the generation rolled back and tried to restore configuration files owned by the deleted user. Ownership could not be resolved, the rollback failed, the journal ended `needs_attention`, and the account stayed `terminating` with its user and home already gone.

## Decision

- Deleting the user cannot be undone, so it runs only after everything that can be checked. The terminate generation keeps the reversible teardown: it stops and disables the account units and slices, removes their unit files, FPM pools and runtime configuration, and drops the account's vhosts, zones and mail configuration. It then runs the config tests and the DNS candidate validation before activation, and the health probes, host name check and DNS observation after the reload. A failure up to this point rolls back while the user still owns its files.
- The generation is activated, its manifest written and its journal committed. Only then does the retirement run, in this order: quota clear, `userdel -r`, home removal, Podman runtime directory, MariaDB drops, PostgreSQL drops. The preflight admits these targets and the SQL runner before any host effect.
- A committed generation is never rolled back. A failed retirement step stops that account's retirement. The account stays `terminating`, the reconcile result stays `applied` (the host is consistent and verified for the remaining accounts) and carries `incompleteRetirements: [{ accountId, username, userRemoved, failedStep }]`. The audit entry `reconcile.applied` records the same list.
- `generations/journal/retirement-<accountId>.json` records `removing` before `userdel` and `removed` after it. The next reconciliation reads it: `removed` omits the quota clear and `userdel`; `removing` (outcome unknown, for example after a crash) omits the quota clear and repeats `userdel`, which succeeds for an absent user, and the username stays reserved while the account is terminating. A record that names another username or uid fails closed. While an account is terminating, the reconciler never reports `noop`, so every later reconciliation resumes at the failed step. The record is removed after the account leaves desired state.
- The API purge answers HTTP 503 `SERVICE_UNAVAILABLE` with `reason: account_retirement_incomplete`, `userRemoved`, `failedStep`, `stateChanged: true` and `verificationRequired: true`, and keeps the account and its identities until a later reconciliation completes the removal.
- Account provisioning with a request key whose completed operation's account no longer exists (it was terminated since) is refused before any lease or host effect with HTTP 409 `CONFLICT`, `reason: provisioning_key_already_completed`, `stateChanged: false`. Replay protection is unchanged: the key still never authorizes a second creation; the caller sends a new key.

## cPanel reference

WHM "Terminate an Account" removes the account's configuration, user, home and databases in sequence and does not restore a removed user when a later step fails. This design keeps that outcome and adds two safeguards: a verified generation before the irreversible steps, and a resumable record after them.

## Open

The ordering and the failure after `userdel` are covered by portable tests with the fake executor. A native run that injects a failure after `userdel`, and a crash during retirement on a real host, are not yet qualified.
