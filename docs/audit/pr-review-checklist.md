# PR review checklist

Use this with the 2026-10-24 audit (`docs/audit/code-quality-2026-10-24.md`). Review the diff, not the author. A docs-only or design-port PR still answers the rows it touches. Skip a row only by saying why it does not apply.

The reviewer posts a comment. The reviewer does not merge.

## Block the PR

- [ ] No fabricated cryptographic material. DKIM `p=` is the live public key for a domain the caller owns (RFC 6376 §3.6.1). A hash of a label, a fixture PEM, or `default._domainkey` invented beside OpenDKIM is a stop.
- [ ] OpenDKIM SigningTable and KeyTable are rebuilt from the current desired domain set. A removed domain disappears. `InternalHosts` / `ExternalIgnoreList` do not gain customer domains or `*.domain`.
- [ ] No new `/host/dkim-sign` (or any message-signing HTTP route) unless it checks that the caller owns the From domain and the key, and the tests cover a foreign domain.
- [ ] Custom nginx/apache includes are parsed. `proxy_pass`, `fastcgi_pass`, `alias`, `root`, `include`, and handler directives are rejected wherever they sit on the line, not only at column 0. Userdata files are not included by the edge renderer until that parser is deny-by-default.
- [ ] Non-root reconciliation does not send `force: true`. A failed apply does not leave a root-owned drop-in in place.
- [ ] The API process does not gain new `readFileSync` / `spawnSync` / `execFile` of host configuration on a request path. Host facts come from the agent.
- [ ] Agent tools check the caller: root-only stays root-only, account tools call the account assertion, and a new route cannot sit between `authenticateCaller` and the role check the way `/host/dkim-probe` does.
- [ ] `expectedPeerUid` is set for every way the agent app is constructed, including in-process `fetch`. A missing peer context must fail closed.
- [ ] Paths and argv stay allowlisted. No shell string. Symlink and `O_NOFOLLOW` behavior is preserved on token and key files. Account file I/O stays inside the account home.
- [ ] SOA serials go through `serialFor` / `bumpSerial`. No new `2026102201`-style constant. No TEST-NET address published as if it were the server.
- [ ] Audit rows do not store raw shell commands, passwords, tokens, or message bodies.
- [ ] Tests were not weakened to go green. A pixel or snapshot gate exits non-zero when the diff crosses its budget. `process.exit(1)` only in `catch` is not a gate.
- [ ] No mock, fixture, or sample key is imported by production code. `window as any` stays in tests.

## UI code standards (code-measurable)

Visual QA is a separate audit. These rows are source checks.

- [ ] Spacing, type, radius, elevation, duration, and easing come from `apps/web/src/tokens.ts` custom properties. A new raw `#hex`, `Npx` (other than a documented 1px hairline), or `Ns` / `Nms` needs a token first.
- [ ] New spacing is a multiple of 4. Prefer the existing 8 / 16 / 24 / 32 rhythm. Do not add another 10 / 11 / 14 / 18 / 22 / 38 step.
- [ ] Type uses the role tokens (`--xp-type-caption` through `--xp-type-page`). The 13/14/16/18/26 table is the current standard. A golden-ratio or major-third scale is a `STANDARDS.md` change, not a one-off `font-size`.
- [ ] Interactive controls use `--xp-hit-target` (44px). WCAG 2.2 success criterion 2.5.8 is 24px minimum and is not the product bar.
- [ ] `:focus-visible` remains visible. No `outline: none` / `outline: 0` unless a token ring replaces it on the same rule.
- [ ] Motion sits under `@media (prefers-reduced-motion: reduce)` or the shell controller’s matchMedia short-circuit. New `element.animate` durations use tokens.
- [ ] Direction uses logical properties (`margin-inline`, `padding-inline`, `inset-inline`, `text-align: start/end`). No new `margin-left`, `text-align: left/right`, physical inset `box-shadow`, or `translateX` that flips sign under `dir=rtl`. LTR identifiers use `<bdi dir="ltr">` without a physical text-align override.
- [ ] Every new `input`, `select`, `textarea`, and icon-only `button` has a visible label, `label for`, or `aria-label`. Roles that are not the native role (`meter`, `switch`, `radio`, `dialog`) include the state attributes those roles require.
- [ ] Board-port screens consume the same tokens as the shell. A second hex palette in a template string is a stop.

## Tests and delivery

- [ ] `pnpm test` and `pnpm typecheck` were run on Node 26.12.1, or the PR says why a docs-only change did not run them. Pasted results include counts. Do not invent a pass count.
- [ ] Invalid input and the failure path are tested for any new parser, signer, or authz check.
- [ ] `pnpm audit` is clean, or new advisories are listed with a reason.
- [ ] Lockfile and exact versions stay intact. No new dependency without a reason recorded in the PR.
- [ ] GitHub Actions workflow files are not edited unless the owner asked. Local gates remain the running check while Actions are disabled.
- [ ] Secrets are not printed in logs, test output, or the PR body.

## Standards the reviewer can actually cite

Cite a clause only when this checklist or the audit names it. Do not invent ISO subsection numbers.

- OWASP ASVS 5.0.0: V6.2.12 breached passwords, V6.3.3 MFA for privileged roles, V8.2 / V8.4 object and tenant authz, V11.2.3 key strength, V11.4.2 password KDF. CSV: https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv
- OWASP Top 10 2021 A01, A02, A03, A05, A09: https://owasp.org/Top10/
- WCAG 2.2: 2.4.7, 2.5.8, 1.3.1, 3.3.2, 4.1.2. Contrast is out of this checklist.
- CSS Logical Properties: https://www.w3.org/TR/css-logical-1/
- RFC 6376 §3.6.1 and RFC 1912 §2.2 for mail-auth DNS.

## Comment shape

One comment on the PR:

1. Verdict: approve, or request changes. Name the checklist rows that failed.
2. Each finding: `path:line`, what breaks, what to change. No praise paragraph.
3. State which commands were not run.
