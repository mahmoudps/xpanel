# Native qualification and the activation gate (2026-11-07)

Owner decision 9 (2026-11-06): a tool goes live only with native proof on all five profiles (`ubuntu-22.04`,
`ubuntu-24.04`, `almalinux-9`, `rocky-9`, `centos-stream-9`); a tool that technically cannot exist on a profile may be
qualified on the others. Until this change `packages/catalog/src/data/delivery.ts` was empty and nothing could fill
it, so every gated write control stays disabled. This records the reviewed path from an installed release to that file.

## Path for one release

1. **Candidate.** A clean commit that ships the empty delivery publication, its packaged artifact and a reviewed
   verification target (`scripts/evidence/target.mjs`, all five profiles).
2. **Profile guests.** Install the artifact, have the installer or reviewer pin the installed binding (schema in
   `scripts/evidence/server-information.md`), then run `scripts/qualification-runner.mjs` with `--slot=unit`,
   `--slot=host` and `--slot=browser`. The outside observer runs `--slot=external` against each guest.
3. **Record.** `scripts/evidence/record.mjs` turns the receipts into a detached bundle; `verify.mjs` and `status.mjs`
   show what is complete.
4. **Publish.** `scripts/qualification-aggregate.mjs` re-validates every bundle and raw report and renders
   `delivery.ts`. The rendered file is the only change in a reviewed publication commit.

## Slots

The tier model is unchanged: implemented needs unit; integrated needs http and browser; verified needs linux, browser
and external, on every required profile.

| Runner slot | Receipts it backs | Where and how |
|---|---|---|
| `unit` | implemented/unit | The reviewed Vitest cases of the tool, run from the target checkout on each profile guest. Each check is one case matched by file and full name. No host executor is involved, so the receipt says `fake`, which the contract allows only for unit. |
| `host` | integrated/http, verified/linux | Real HTTPS to the installed release, normal root sign-in and sign-out. The Linux observation does not use the API: for `audit-log` the stored rows are read read-only with the pinned runtime's own SQLite and compared field by field. One report backs both receipts, as the existing server-information runner does. |
| `browser` | integrated/browser, verified/browser | Real Chromium from the target checkout's pinned Playwright, against the installed origin, signed in through the login form. The page is compared with the API read through the same browser session. |
| `external` | verified/external | The observer outside the guest: DNS resolution of the origin name, the served certificate verified with the observer's normal trust store (issuer recorded), and the criterion through the public ingress. The guest's OS identity comes from its pinned passed host report; the observer checks that it is not the measured host. |

Every slot verifies the installed release (manifest, provenance, process identity) and the runner's own files against
the pinned target before and after the run. A report is written for every run; receipts only for a passed run with
confirmed cleanup. Missing checks are `blocked`, a failed check is `failed`; neither yields a receipt.

**Why the existing Chromium partitions are not collected as browser evidence.** Their fixtures inject
`FakeHostExecutor` and bind source with the full Git inventory digest, not the executable-input fingerprint. A
receipt from them would be a fake executor relabeled as real, which the contract refuses. The browser slot reuses
the same pinned Chromium and browser cache instead, pointed at the real installed release.

**External where a criterion needs it.** Every verified tier needs an external observation, so the external slot
always observes DNS, the certificate and the criterion through the public ingress. A criterion that names mail
delivery or another outside system adds its own external check to its driver. No current driver needs mail delivery,
so no SMTP observer exists yet.

## Drivers

`scripts/qualification-drivers/` holds the reviewed drivers: one module per audit slice (`s1.mjs` to `s10.mjs`) on a
shared `kit.mjs`. `scripts/qualification-plan.mjs` turns them into the inventory. Requirements copy the catalog
acceptance text, so a changed criterion invalidates old evidence. A tool without a driver is planned as `not_run` and
never gets a receipt.

A driver acts as a real client: the panel API on the listener of its actor (root, the account owner, the mailbox) and
the served site as a visitor reaches it. It never reads host files and never uses a shell. It declares one check ID per
clause of the criterion. A clause the product does not implement fails, and a clause no API client can observe stays
`blocked` with its reason, so that tool gets no receipt.

Refusals are compared literally: there are no code aliases. `docs/decisions/qualification-codes.md` lists, per tool, each
criterion corrected to the product's vocabulary and how each owed product fix closed.

One independent oracle exists beside the API: in the host slot only, a driver may read `statfs` through `host.disk`, as
`audit-log` reads its store. It is the kernel's figure, so it can check the product's. Such a check is declared `hostOnly`
and is not repeated in the external slot.

Each driver registers an undo step for what it creates. The steps run after any failure, and a step that cannot confirm
removal keeps the tool from a receipt. Owner and mailbox drivers share one run-scoped account, created through the API
with its own plan and feature list, so existing accounts are never touched. Every object name carries the run tag, so
a rerun cannot meet an earlier run's objects. Receipts are written only after that account is confirmed gone.

Every driver's page and the actor who opens it come from the catalog navigation at load time, so a moved route cannot
leave a stale declaration, and a tool that is not on a page cannot declare a driver. All 537 in-scope tools have a page,
so no tool has a path to `verified` without the browser slot.

The browser slot signs in as that actor, opens the page, waits for it to settle and requires no closed surface. The evidence
rule stays: a page counts only when API values appear in its main region. Those values are the identifying strings of the
declared read and of every API reply the page itself fetched, never the actor's own name, or the exact values a driver
names in `shows`. If no reply held a value to compare, the check is `blocked`, not passed. The slot observes; writes go
through the API. The external slot runs the same driver from outside the host.

A tool whose gate refuses writes until verified sets `requires_qualification_admission`, with `gate` naming the tool whose
catalog state decides. Three do: `dynamic-dns` (gated by `dns-zone-records`), `aapanel-default-index` and
`aapanel-default-site`. Without admission such a driver is `blocked` before any request.

## Running on a host for the first time

A driver that changes host-wide state declares `restores`: the reads that hold that state. The kit reads them before the
driver runs and refuses to run if it cannot. It reads them again after the undo steps and compares them, ignoring
revisions and timestamps. A difference is a leftover, whatever the undo step reported, so that tool gets no receipt.

These drivers run last, one at a time. After one restore is not confirmed, every later one is stopped and reported, so one
failure cannot stack on another. The run list and order are in the dry run (`shared`). Take a guest snapshot before the first
run. Compiler access stays restricted server-wide for the length of its driver, and settings drivers trigger reconciles.

Transfer sessions are cancelled and then removed through `DELETE /api/transfers/sessions/{id}`, which accepts a cancelled
session only, so a run leaves no history rows.

## Profile subsets

`PROFILE_EXCLUSIONS` in `packages/catalog/src/delivery.ts` lists reviewed technical impossibilities as
`{ profiles, reason }`. It is empty today. `assessDelivery` and the evidence contracts then require only the remaining
profiles, and the derived requirement carries that subset. An entry without a reason, outside the target, or
excluding every profile fails closed.

## The publication is bound to the qualified source

`delivery.ts` is an executable input, so publishing changes the source fingerprint. The rules:

- The candidate must ship the exact empty module (`renderDeliveryModule([], null)`).
- `publishedSourceFingerprint` computes the source fingerprint with `delivery.ts` replaced by that empty module. It
  must equal `deliveryTarget.sourceFingerprint`. The aggregator refuses otherwise.
- Once a publication exists, `scripts/test-qualification.test.ts` runs the same check on the checkout: 2611 files
  were hashed in 433 ms on the 6 vCPU test guest. Any later source change fails it until the publication is removed
  or the release is qualified again. `--check` compares the committed file with a fresh rendering.
- The target artifact is the candidate archive. The shipped archive differs from it only by the publication.

Without `/etc/xpanel/capability-acceptance.json` the API now starts from the shipped catalog. Before this change it
used empty evidence, so a publication could never open a gate. Host readiness probes still demote tools.

## Qualification mode (owner decision 11, 2026-11-07)

Three API mutations refuse while their tool is unqualified: dynamic DNS update (`dns-zone-records`),
`aapanel-default-index` and `aapanel-default-site`. The web disables every gated write control on an unqualified
candidate. A tool needs evidence to open, and those tools could not produce it while closed. Qualification mode breaks
that deadlock on lab hosts and changes nothing elsewhere.

**The switch.** The mode is on only when all of these hold; every other state, and every read failure, means off:

- The file `/etc/xpanel/qualification-mode` exists, is a regular file with one link, is not a symbolic link, is owned
  by uid 0 and has mode exactly `0444` (the API runs as `xpanel` and must read it).
- `/etc/xpanel` is a directory owned by uid 0 that neither group nor others can write.
- Its content equals this host's `/etc/machine-id`, so a copied file or a cloned disk does not carry the mode to
  another machine.
- The release shipped no delivery publication (`deliveryTarget === null`) and the host has no operator acceptance
  bundle. A published release is production and never honours the file.

The operator turns it on by hand and off by deleting the file. The next request sees either change:

```text
install -o root -g root -m 0444 /etc/machine-id /etc/xpanel/qualification-mode
rm /etc/xpanel/qualification-mode
```

The installer, packages and release scripts never create this file; a test scans them. The reader takes no request
input, and the agent's write allowlist does not admit the path, so no request can turn it on.

**While it is on.**

- Every page in both themes shows a banner (`data-qualification-mode`), including sign-in and status pages.
- Every state-changing request writes one `qualification.operation` audit row before it runs: actor, method and path,
  never the query or body. If the row cannot be written the request fails and nothing runs. Dynamic DNS arrives as GET
  and is recorded too. The row records that the operation was requested; the tool's own audit row records its result.
- Only then does the catalog admit a tool: `admitForQualification` runs after `qualifyHostTools`, at runtime, on the API
  catalog. It opens a tool only when a live Linux report passes every declared readiness probe, so an undeclared
  or failing prerequisite stays closed. Every existing gate reads that catalog, so no gate gained a bypass.

**Limits of the audit row.** Rows cover HTTP requests. A terminal's keystrokes are not itemised: the request that opens
the session is recorded, and the terminal's own audit rows stay as they are. The local root command line does not pass
through the request path, so its commands keep only their own audit rows.

**What it never does.** An admitted tool carries `delivery.admission: 'qualification'`, empty evidence and a reason
saying so. Admission never reaches `delivery.ts`, which is rendered only from bundles. A report records the mode it
ran in (`admission`). The evidence rules above are unchanged: a report without its receipts proves nothing.

Off is the default on every host, and turning it off takes effect at once because the file is read per request.

## Budget

The runner drives tools one after another and starts no daemon. Each tool slot has a declared deadline (120 s by default) and a
bounded count of HTTPS requests of at most 5 s and 2 MiB each, and a 300 s unit run. A driver declares only its own requests;
each actor's transport adds five for the runner's session (anonymous probe, sign-in, catalog, sign-out, revoked read), so a
spent driver budget can no longer leave a session unrevoked.

Unit runs on a qualification host see the ordinary catalog: an application built without a catalog provider, as every test
builds one, never reads `/etc/xpanel/qualification-mode`. Only the startup provider does. The browser slot waits for the sign-in
form's own navigation to its workspace before it opens the tool page. The store oracle is a read-only SQLite read. No profile
guest was measured in this change: the runner was built and tested without host access.
