# Lifecycle coordinator startup verification

Date: 2026-11-06. Scope: `xpanel-lifecycle.service` (`apps/agent/src/ops-upgrade-native.ts`) startup.

## Problem

At startup the coordinator verifies its registered helper archive and prepared release tree under retained descriptors of every ancestor directory (`scripts/release-verifier.mjs`). An ancestor's identity includes its size, link count and modification and change times. Any entry created, renamed or removed in an ancestor during that verification, for example by another service under `/var/lib`, changes those times. The archive callback then fails with `ARCHIVE_USE_UNCERTAIN` (cause `FILE_CHANGED`, "Protected ancestry changed"), the top-level start rejects, and systemd leaves the unit `failed`. Nothing restarts it, so upgrades and recovery stay unavailable until an operator starts it again.

## Decision

- Bounded retry of the startup verification only: `verifyCoordinatorStartup` repeats the complete `withVerifiedCoordinatorOwnership(observeLauncher)` verification when the failure's cause chain carries `FILE_CHANGED`, at most 3 attempts in total with 1 s and 2 s pauses, and logs each retry on stderr. Every attempt is a fresh verification from scratch: new descriptors, digests, tree inventory and ownership checks. The retry runs before any socket is created and before any effect, so it never resumes a partial state.
- Any other refusal (digest mismatch, ownership drift, unsafe tree, missing file) fails on the first attempt. A third change also fails closed: the process exits non-zero and the unit stays `failed`, which is the truthful state.
- No systemd restart policy. The coordinator unit text is part of the verified coordinator contract (`renderCoordinatorUnit`, checked by digest on every ownership verification). Changing it to `Restart=on-failure` would require a coordinator rotation on every installed host. Restarting the whole process also repeats the same verification that the in-process retry already repeats, and a restart loop would keep re-running root startup on a host whose source really changed; the in-process retry is bounded by design and leaves a failed unit after it.

## Not changed

The verifier's ancestry identity check is unchanged; no field is excluded and nothing is cached between attempts.
