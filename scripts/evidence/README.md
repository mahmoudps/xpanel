# Detached capability evidence

This tooling records acceptance against an immutable source and release artifact. It does not execute native services or infer acceptance from health probes. Evidence never changes `data/delivery.ts` or the artifact it qualifies.

## Contracts

- `identity.mjs`: `identifySource(root, {requireClean})` is read-only; its versioned `xpanel-executable-inputs-v1` digest uses the existing snapshot digest function over explicit executable/build/test roots, `bin/` and `deploy/` release inputs, plus the acceptance matrix and mapping. It is **not** a browser Git-tree digest or an archive digest. Commit, tree, dependency lock, pinned Node and the input manifest are retained. `assertSameSource(before, after)` also works for dirty development checks.
- `target.mjs`: `createVerificationTarget({root, artifact, provenancePath, provenanceSha256})` requires a clean commit, hashes the artifact using bounded memory, checks source stability and requires a packaging provenance receipt with a separately reviewed digest pin. The receipt must bind the canonical source identity and the artifact hash/size. The default target requires all five profiles: `ubuntu-22.04`, `ubuntu-24.04`, `almalinux-9`, `rocky-9`, `centos-stream-9`.
- `record.mjs`: `recordEvidenceBundle({root, artifact, targetDocument, requirements, receiptPaths, evidenceRoot})` validates full receipts and their raw reports, checks source/artifact stability, and emits a detached v1 bundle. Output creation is exclusive; existing evidence is never overwritten.
- `runtime.mjs`: `verifyEvidenceBundle(bundle, {expectedTarget, expectedRequirements, evidenceRoot})` validates all profile/stage/environment slots. Supplying `evidenceRoot` additionally rechecks original receipt/report bytes and report semantics. `loadTrustedEvidenceBundle({path, expectedSha256, expectedTarget, expectedRequirements})` is the production Linux reader: root-owned non-writable ancestors and file, no symlinks, bounded content, external SHA-256 pin, independently reviewed requirements and deployment-target match are mandatory. Its closure (`contracts`, `reports`, `files`, `shared`) uses only Node builtins, with no Git/VM/CLI imports. `verify.mjs` re-exports these functions and supplies only the command wrapper.

The bundle retains the existing `VerificationTarget` and `CapabilityEvidence` row shapes, plus source identity, reviewed requirements, packaging provenance and a receipt/report manifest. Runtime catalog injection is a separate integration; these tools do not promote host probes to accepted delivery. Pins must be provisioned in trusted operator configuration separate from submitted files; a hash supplied alongside an untrusted file is not a trust anchor. Packaging provenance pins are issued only after review of the producer and authenticated release contents. Capability bundle pins are issued only after checking the reviewed requirements, producer and original reports. The pin authenticates that operator review; the tooling cannot independently establish that caller-written `executor:"real"` or `proofExecuted:true` reflects actual execution.

## Reviewed requirements and receipts

Requirements are an array of `{toolId, acceptance, checks}`. `acceptance` must match the catalog criterion exactly. `checks` explicitly maps `unit`, `http`, `browser`, `linux`, `external` to nonempty unique expected case IDs. A capability needs implemented/unit, integrated/http+browser and verified/linux+browser+external **for each profile**. Expected cases come from reviewed runner inventories, not submitted report counts.

A full receipt has:

```json
{
  "schemaVersion": 1,
  "kind": "xpanel-capability-acceptance",
  "runId": "batch-name",
  "receiptId": "unique-receipt-name",
  "toolId": "server-information",
  "acceptance": "Exact catalog acceptance text",
  "coverage": "full-acceptance",
  "stage": "verified",
  "environment": "linux",
  "profile": "ubuntu-24.04",
  "sourceAlgorithm": "xpanel-executable-inputs-v1",
  "sourceFingerprint": "64 lowercase hex from the target",
  "sourceBefore": "same source fingerprint",
  "sourceAfter": "same source fingerprint",
  "artifactSha256": "64 lowercase hex from the target",
  "commit": "exact target commit",
  "result": "passed",
  "executor": "real",
  "startedAt": "2026-10-29T00:00:00Z",
  "finishedAt": "2026-10-29T00:00:01Z",
  "runtime": {"node": "v26.12.1", "platform": "linux", "profile": "ubuntu-24.04"},
  "host": {"osRelease": {"id": "ubuntu", "versionId": "24.04", "name": "Ubuntu"}},
  "cleanup": {"ok": true, "errors": []},
  "report": {"kind": "checks-v1", "path": "run.report.json", "sha256": "raw report SHA-256"}
}
```

External receipts additionally require an identified independent observer: `observer:{independent:true,identity:"observer identity"}`. Unit receipts may use a fake executor; all other acceptance environments require real execution. Linux receipts require an actual Linux runtime, and observed OS release values must map to the claimed profile.

Supported report adapters:

- `checks-v1`: `{schemaVersion:1,status:"passed",proofExecuted:true,checks:[{id,status:"passed",observed:...}]}` with exactly the reviewed IDs and an actual non-null observation per check.
- `vitest-v1`: successful JSON report with exact assertion names/counts, all assertions and suites passed, no pending/todo/failures/collection errors.

Unknown formats fail closed. Existing executor/agent-boundary VM receipts are limited primitive proofs; existing app/browser fixtures use fake host execution and incomplete source binding. They cannot be relabeled as full capability envelopes. Their native producers need a reviewed full-acceptance integration before this recorder will accept them. Browser partition exit code plus output existence also cannot substitute for report validation.

## Commands

Use the pinned Node runtime. Output directories below are examples of ignored local evidence locations, not tracked inputs:

```text
node scripts/evidence/target.mjs --root=<checkout> --artifact=<immutable-archive> --provenance=<packaging-receipt.json> --provenance-sha256=<independently-reviewed-pin> --output=<detached-target.json>
node scripts/evidence/record.mjs --root=<checkout> --artifact=<immutable-archive> --target=<target.json> --requirements=<reviewed-requirements.json> --receipt-list=<relative-receipt-paths.json> --evidence-root=<raw-receipt-directory> --output=<detached-bundle.json>
node scripts/evidence/verify.mjs --bundle=<bundle.json> --target=<target.json> --requirements=<reviewed-requirements.json> --evidence-root=<raw-receipt-directory>
node --test scripts/evidence/evidence.test.mjs
```

The same assertions are discovered by ordinary unit/portable lanes through `scripts/test-evidence.test.ts`; that wrapper registers them directly with Vitest and starts no extra process.

The receipt list is a JSON array of paths contained in `evidenceRoot`; report paths are safe relative paths under the same directory. Raw reports remain separate from runtime bundles and must be reviewed for private content before any publication. No command here deploys, starts services or changes authorization. Successful tooling tests do not establish native feature acceptance.
