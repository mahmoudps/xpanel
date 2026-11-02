# Server information: real HTTP and Linux qualification

The catalog criterion is:

> The API returns CPU model, core count, total RAM and per-mount disk usage matching the OS values within 1%.

This adapter covers the **HTTP** and **Linux** slots only. It never creates unit, browser or external-location receipts. A same-host independent OS process is a native measurement oracle, not an external-location acceptance environment. The five-profile release gate still needs every required slot for every distribution.

## Grounded interfaces

Normal root-authenticated `GET /api/server/info` forwards root-authenticated agent `GET /host/info`. The adapter expects:

- `identity.model`, `identity.cores`, `memory.totalBytes`.
- Additive `disks:[{mount,totalBytes,usedBytes,availableBytes,...}]` for every visible mountpoint. Legacy root-only `disk` remains supported by the application but cannot satisfy this criterion alone.
- `diskCoverage:{status:"complete",source:"df",inventorySource:"proc-self-mountinfo",mounts,unavailableMounts:[],unexpectedMounts:[],mountInfoSha256,...}`. The inventory hash must match both independent observations in the agent's actual mount namespace.

The OS observer runs as a separate process, imports no application/agent metric parser, and uses `lscpu`, `getconf`, mountinfo and native `statfs`. All visible mountpoints, including pseudo and bind/file mounts, remain in scope. Missing measurements, unsupported tools, changing topology or incomplete API coverage fail closed. CPU text/count must match; numeric byte metrics must match both bracketing OS observations within 1%. Large volatility therefore cannot be used to excuse an inaccurate metric.

## Trusted preparation

Run only on an admitted disposable fixture under the qualification supervisor's owned cgroup and exclusive heavy-lane slot. The supervisor supplies a finite outer runtime and verifies retirement after failure. No command here prepares a VM, changes system services, writes hosting data or enables an authentication bypass.

The pinned Node executable must be the same executable used by the actual API/agent processes. Before and after observation, the adapter verifies:

1. Target and installed-binding files against independently approved SHA-256 pins, with root-owned non-writable ancestry and files.
2. The complete installed runtime inventory against the separately pinned authenticated release manifest; every listed source file is hashed. Manifest provenance, lockfile and supplied immutable archive must match the target.
3. Real API and agent PID, start ticks, UID, working directory, executable, command hash and boot identity. The observer namespace must equal the agent namespace.
4. The qualification adapter's own code against the frozen target source manifest. A newer adapter cannot qualify an older artifact by assertion.

The installed-binding pin must be issued by the trusted installer/reviewer **after** authenticating the archive and observing normal service startup. It is not accepted from HTTP, a user-controlled request, or a hash embedded in the submitted binding itself. Actual dependency-install proof remains part of the supervisor's fixture admission; this adapter does not claim a database or full dependency-integrity audit.

The installed binding schema is:

```text
{
  schemaVersion: 1,
  kind: "xpanel-server-information-installed-binding",
  target: {sourceFingerprint, artifactSha256},
  sourceAlgorithm: "xpanel-executable-inputs-v1",
  commit: <exact source commit>,
  profile: <one canonical target OS profile>,
  releaseRoot: <real installed release directory>,
  manifestSha256: <authenticated release-manifest.json hash>,
  bootId: <observed Linux boot UUID>,
  origin: <configured HTTPS xWHM origin>,
  address: <observed local IPv4 or IPv6 address>,
  qualificationAdmission: "normal-root-api" | "existing-host-probes" | "trusted-release-evidence",
  roles: {
    api: {pid, uid, startTicks, commandSha256, executableSha256},
    agent: {pid, uid: 0, startTicks, commandSha256, executableSha256}
  }
}
```

`normal-root-api` describes the current root-only API path, which has no tool-specific delivery gate. Record the actually reviewed admission path; never add a new permissive mode to get evidence through.

## Authentication and bounded effects

Credentials are read from a root-owned `0600` file or inherited regular-file descriptor `>=3`. A descriptor is an alternative to a file, not a second source. The JSON schema contains `username`, `password` and optional current `totpCode`; values are never accepted as CLI arguments or environment variables and are never included in evidence. An enrolled factor is supplied normally; this runner does not disable MFA or alter policy.

The runner uses normal HTTPS root login, the audience-bound secure xWHM cookie, the returned CSRF token, one root API measurement, and normal logout. It records actual anonymous, forged-header and post-logout denial responses. No skipped or invented authorization case counts as passed. Login/session/audit rows are the only expected fixture effects; an unknown login outcome or unconfirmed logout leaves cleanup unconfirmed.

HTTPS certificate/hostname verification is always enabled. Requests pin the reviewed local address and support Node's `lookup({all:true})` array contract, without forwarding authentication headers, redirects, retries or raw response/error logging. The fixed request inventory is capped at eight requests, each at most 5 s with a 2 MiB response ceiling; the runner has a 60 s deadline. The separately supervised OS child has its own timeout.

## Invocation and outputs

All paths below are operator-selected protected or detached paths; no secret value is placed on the command line:

```text
node scripts/evidence/server-information-runner.mjs --root=<source-root> --target=<target.json> --target-sha256=<reviewed-pin> --binding=<installed-binding.json> --binding-sha256=<reviewed-pin> --artifact=<immutable-archive> --origin=<HTTPS-origin> --address=<local-IP> --credential-file=<protected-login.json> --run-id=<unique-run> --output=<detached-observation.json>
```

Use `--credential-fd=3` instead of `--credential-file` when the supervisor supplies an inherited protected regular file. `--ca-file=<operator-approved-CA.pem>` optionally selects a root-controlled CA for isolated fixtures; TLS validation stays enabled.

A passed real run writes an observation plus two hash-bound report/receipt pairs (`http` and `linux`) using exclusive creation. A failed/blocked run writes no passing capability receipts. All missing unit/browser/external slots remain explicitly `notRunSlots`. The ordinary evidence recorder will reject the incomplete capability bundle until independent real evidence supplies those slots. Never present adapter tests or a successful native subset as a fully verified capability.

`server-information.test.mjs` contains the reviewed pure contract tests. The ordinary unit/portable inventory discovers those assertions through `scripts/test-server-information-evidence.test.ts`; the tests start no real services, login or OS command.
