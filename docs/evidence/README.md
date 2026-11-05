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

The only path to `deliveryEvidence` remains: complete detached bundle for the exact source and artifact, all five declared profiles, real-executor linux + browser + external acceptance per tool, reviewed requirements and pins, then a separate reviewed change that publishes those exact rows. Until then `delivery.ts` stays empty and `assessDelivery` keeps every in-scope tool `researched`.

## Remaining real evidence required before any tool is verified

None of the following exists today; until it does, no tool can be `verified` and the status surface rightly reports `researched`/`blocked`:

1. A built and signed release artifact plus a reviewed `VerificationTarget` for the exact candidate source.
2. A reviewed requirements inventory for the tool being qualified with exact acceptance text and unique check IDs for unit, http, browser, linux and external (the in-repo `server-information` inventory is the only reviewed example; the others do not exist yet).
3. Real per-profile acceptance on all five declared profiles (`ubuntu-22.04`, `ubuntu-24.04`, `almalinux-9`, `rocky-9`, `centos-stream-9`), with the actual installed artifact and browser and external observations. Current browser fixtures declare a fake host executor and incomplete source binding; they cannot be relabeled.
4. Real executor receipts for every environment. The current `server-information` runner covers only the integrated/http and verified/linux slots (two of six) and its receipts record the missing slots as `notRunSlots`; it cannot produce a complete bundle.
5. A separately reviewed delivery publication of the exact accepted rows. This tooling must never populate `deliveryEvidence`; that file stays `[]` with `deliveryTarget = null` in this change.

What is not verified by this document or by the tooling it describes: no catalog tool is accepted, no host, browser, external or per-profile qualification is established, no upgrade or recovery proof is established, and no production readiness claim follows.
