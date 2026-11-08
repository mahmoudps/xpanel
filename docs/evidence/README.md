# Evidence surfaces: bundles and generated status

Status: tooling documentation. Prelaunch; NO-GO. Nothing in this directory establishes product acceptance by itself. The shipped catalog still has **0 verified capabilities** and `packages/catalog/src/data/delivery.ts` ships exactly `deliveryEvidence = []` and `deliveryTarget = null`.

This document covers two separate evidence surfaces and their exact commands:

1. **Capability acceptance bundles** - the existing detached `EvidenceBundle v1` recorder and verifier (`scripts/evidence/record.mjs`, `runtime.mjs`, `verify.mjs`, contracts in `contracts.mjs`). These are the only inputs that can eventually qualify a tool.
2. **`scripts/evidence/status.mjs`** - a generated status report over reviewed requirements and detached bundles, with a CI gate. It is read-only: it never writes catalog delivery data and it never promotes anything.

## Trust model

- Acceptance evidence is stored detached from source and from the release artifact, and is loaded only from operator-controlled paths. The existing loader (`loadTrustedEvidenceBundle`, the API acceptance configuration) requires root-owned, non-writable paths, an externally reviewed SHA-256 pin, the deployed `VerificationTarget` and independently reviewed requirements. A digest supplied next to an untrusted file is never a trust anchor.
- A capability becomes accepted only when a complete `EvidenceBundle v1` covers the exact deployed source fingerprint and artifact digest, every declared profile independently supplies implemented/unit, integrated/http+browser and verified/linux+browser+external results, non-unit environments use a real executor, reports pass semantic inventory validation (not just exit code), cleanup is confirmed, and the trusted-operator pins match. One-profile results are intermediate development evidence.
- `status.mjs` consumes that same bundle schema and the same validators. Every supplied receipt, report and evidence row is validated. A tool is `verified` only when every declared profile has complete passed acceptance in every tier. Incomplete bundles are reported as `blocked`; they cannot be promoted by this surface. Invalid, forged, stale, mixed-target or duplicate evidence makes the command fail closed instead of producing a weaker report.
- `status.mjs` never writes `delivery.ts` and is not an acceptance authority. A verified status row is a precondition for a separately reviewed delivery change, not the change itself. Tests assert that the shipped delivery data stays empty and unbound.

## Commands

Producers under the existing contract (the placeholder paths are operator-owned, outside source and the artifact):

```text
node scripts/evidence/target.mjs --root=<checkout> --artifact=<immutable-archive> --provenance=<packaging-receipt.json> --provenance-sha256=<independently-reviewed-pin> --output=<detached-target.json>
node scripts/evidence/record.mjs --root=<checkout> --artifact=<immutable-archive> --target=<target.json> --requirements=<reviewed-requirements.json> --receipt-list=<relative-receipt-paths.json> --evidence-root=<raw-receipt-directory> --output=<detached-bundle.json>
node scripts/evidence/verify.mjs --bundle=<bundle.json> --target=<target.json> --requirements=<reviewed-requirements.json> --evidence-root=<raw-receipt-directory>
```

Generated status:

```text
node scripts/evidence/status.mjs --requirements=<reviewed-requirements.json> --target=<deployed-target.json> --bundle=<bundle.json> [--bundle=<more-bundle.json>] [--evidence-root=<raw-receipt-directory>] --format=markdown --output=<status.md>
node scripts/evidence/status.mjs --requirements=<reviewed-requirements.json> --target=<deployed-target.json> --bundle=<bundle.json> --check
node scripts/evidence/status.mjs --requirements=server-information
```

- `--requirements` accepts a reviewed requirement JSON file (`[{toolId, acceptance, checks}]`, the same shape `record.mjs` consumes) or an explicit named in-repo inventory. The only named inventory is `server-information`, from `server-information-contract.mjs`.
- `--target` is required whenever a bundle is supplied; omitting it is allowed only for a targetless view, which can show only `researched`/`blocked` and no tool can be `verified`.
- `--bundle` is repeatable. All bundles must contain the identical reviewed requirement inventory and qualify the same source fingerprint and artifact digest; combining mixed targets is rejected. A bundle whose source/artifact differs from the supplied deployment target is rejected as stale.
- `--evidence-root` additionally re-reads the raw receipt/report files and their semantic reports from that directory. Use it whenever the raw files are available.
- `--format=markdown` (default) is human-readable and deterministic. `--format=json` emits the machine document. `--output=<path>` writes the result.
- `--check` is a read-only CI gate: it validates every input and exits 0 only when every reviewed requirement is `verified` for every declared profile. During prelaunch it exits 1 by design. It never treats invalid, mixed or stale evidence as a pass.
- Status values: `verified` means complete passed evidence for every declared profile in every tier; `blocked` means some evidence exists but at least one profile, tier or environment is incomplete; `researched` means no detached acceptance evidence exists. Per-profile claims can be `implemented`, `integrated` or `verified` only for the completed tier prefix; otherwise they are `blocked` or `researched`.

Tests (pinned Node runtime; no workspace `node_modules` and no package-manager install needed):

```text
node --test scripts/evidence/evidence.test.mjs
node --test scripts/evidence/status.test.mjs
```

## Operational records are not CapabilityEvidence

`deliveryEvidence` must stay `[]` and `deliveryTarget` must stay `null` unless a genuinely valid full acceptance bundle exists for the exact artifact and source. Build, backup, acquisition, rotation, upgrade and postflight records, health probes and rendered pages show that an operation happened; they prove nothing about a catalog tool's acceptance (the roadmap explicitly says pure health probes never create `verified` evidence). They have no `toolId`, acceptance criterion, `stage`/`environment` slot, `executor`, profile-bound OS observation, independent observer, semantic check inventory or cleanup confirmation, so they cannot be submitted as `EvidenceBundle` receipts and are rejected by the bundle validator.

The only path to `deliveryEvidence` remains: complete detached bundle for the exact source and artifact, all five declared profiles (or the reviewed subset of a catalog profile exclusion), real-executor linux + browser + external acceptance per tool, reviewed requirements and pins, then a separate reviewed commit whose only change is the `delivery.ts` that `scripts/qualification-aggregate.mjs` renders from those exact rows. Until then `delivery.ts` stays empty and `assessDelivery` keeps every in-scope tool `researched`.

## Native qualification runs

The runner, drivers and publication step are described in [docs/decisions/qualification.md](../decisions/qualification.md). Run every slot as root with the pinned Node, from a root-owned checkout of the exact target commit after a frozen install. All files named below are root-owned operator files; credentials are a `0600` JSON file (`username`, `password`, optional `totpCode`) and never a command-line value. Run IDs must not name hosts.

Check the inputs first. A dry run validates the target, detects the profile and lists the tools, their checks and the missing options; it sends no request and writes nothing:

```text
node scripts/qualification-runner.mjs --slot=host --target=<target.json> --run-id=<run> --dry-run
```

The dry run also names `withoutReadiness`: tools without a `PHASE1_TOOL_PROBES` entry, whose published evidence host readiness would demote on every host. A tool needs an entry before it is worth qualifying.

First qualification target. The 2026-11-07 re-audit counted 168 tools at level 3 or higher that already have readiness probes, so only acceptance evidence is missing ("gate only"), per work slice:

| Slice | s1 | s2 | s3 | s4 | s5 | s6 | s7 | s8 | s9 | s10 | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Gate only | 21 | 11 | 8 | 17 | 19 | 19 | 16 | 17 | 23 | 17 | 168 |

It also counted 37 tools at level 3 or higher without probes. Two of them (`tweak-system`, `apache-global-config`) already had entries on this branch, and 28 now have entries (26 with scope notes; the two Tweak Settings sections still being built have none). The other 7 (`distro-packages`, `web-stack-builder`, `nameserver-report`, `raw-ftp-log-download`, `email-disk-usage`, `connect-devices`, `gitweb`) have no implementation on their own page, so they stay without probes. Qualify the 168 first, then the 30 with entries. Every one of them still needs a reviewed driver in `scripts/qualification-plan.mjs`; today only `audit-log` has one.

On each profile guest, with the release installed and its binding pinned:

```text
node scripts/qualification-runner.mjs --slot=unit --target=<target.json> --target-sha256=<pin> --run-id=<run> --output=<evidence-dir>
node scripts/qualification-runner.mjs --slot=host --target=<target.json> --target-sha256=<pin> --binding=<binding.json> --binding-sha256=<pin> --artifact=<archive> --origin=<https-origin> --address=<installed-address> --credential-file=<login.json> --run-id=<run> --output=<evidence-dir>
node scripts/qualification-runner.mjs --slot=browser --target=<target.json> --target-sha256=<pin> --binding=<binding.json> --binding-sha256=<pin> --artifact=<archive> --origin=<https-origin> --address=<installed-address> --credential-file=<login.json> --run-id=<run> --output=<evidence-dir>
```

Tools marked `requires_qualification_admission` in the plan need qualification mode on the guest, and tools marked `shared` run last with a proved restore; see `docs/decisions/qualification.md`. Write tools that open no gate of their own run without it, and the runner records the mode in each report. `--fixture-domain-suffix=<domain>` names the suffix of the run-scoped account's domain (default `example.net`).

`--slot=host` reads the audit store at `/var/lib/xpanel/control.db` unless `--db=<path>` names the configured one. `--ca-file=<pem>` adds an operator CA for the HTTPS client only. `--tools=<id,...>` narrows the plan; the default is every in-scope tool, and tools without a driver are listed as not run. On the outside observer, with the guest's pinned passed host report:

```text
node scripts/qualification-runner.mjs --slot=external --target=<target.json> --target-sha256=<pin> --binding=<binding.json> --binding-sha256=<pin> --origin=<https-origin> --credential-file=<login.json> --observer=<observer-name> --host-report=<host.report.json> --host-report-sha256=<pin> --run-id=<run> --output=<evidence-dir>
```

Each run writes one report per tool and, only when it passed with confirmed cleanup, one receipt plus its own report copy per backed slot. Exit status `2` means at least one tool did not pass. Copy every `*.receipt.json` and `*.report.json` into one evidence directory, record and verify the bundle as above, then publish from a clean checkout of the candidate:

```text
node scripts/qualification-aggregate.mjs --root=<checkout> --target=<target.json> --bundle=<bundle.json> [--bundle=<more.json>] --evidence-root=<evidence-dir> --output=packages/catalog/src/data/delivery.ts
node scripts/qualification-aggregate.mjs --root=<checkout> --target=<target.json> --bundle=<bundle.json> --evidence-root=<evidence-dir> --check
```

The aggregator publishes only tools complete on every profile they require and lists the others with their missing slots; it refuses another target, a fake executor, a failed result, a duplicate slot, unreviewed requirements and a checkout that differs from the qualified source beyond `delivery.ts`. That publication commit also updates the assertion in `scripts/evidence/status.test.mjs` that pins today's empty publication.

## Remaining real evidence required before any tool is verified

None of the following exists today; until it does, no tool can be `verified` and the status surface rightly reports `researched`/`blocked`:

1. A built and signed release artifact plus a reviewed `VerificationTarget` for the exact candidate source.
2. A reviewed requirements inventory for the tool being qualified with exact acceptance text and unique check IDs for unit, http, browser, linux and external (the in-repo `server-information` inventory is the only reviewed example; the others do not exist yet).
3. Real per-profile acceptance on all five declared profiles (`ubuntu-22.04`, `ubuntu-24.04`, `almalinux-9`, `rocky-9`, `centos-stream-9`), with the actual installed artifact and browser and external observations. Current browser fixtures declare a fake host executor and incomplete source binding; they cannot be relabeled.
4. Real executor receipts for every environment. The current `server-information` runner covers only the integrated/http and verified/linux slots (two of six) and its receipts record the missing slots as `notRunSlots`; it cannot produce a complete bundle.
5. A separately reviewed delivery publication of the exact accepted rows, rendered by `scripts/qualification-aggregate.mjs`. The recorder, verifier and status tools never write `delivery.ts`; that file stays `[]` with `deliveryTarget = null` until such a publication.

What is not verified by this document or by the tooling it describes: no catalog tool is accepted, no host, browser, external or per-profile qualification is established, no upgrade or recovery proof is established, and no production readiness claim follows.
