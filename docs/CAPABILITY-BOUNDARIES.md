# Capability boundaries

A registered document is a navigation destination, not an authorization or service-readiness receipt. Document admission uses the acting principal and the registered role/ACL. An authenticated reseller's own sign-in security page exposes only that reseller's security state, independently of account-list permissions; it grants no global administration access. An unqualified destination shows a disabled summary with bounded account metadata. Unknown destinations remain 404; an unauthorized registered destination remains 403. Opening a view does not qualify its tools.

| Surface | Data and action boundary |
| --- | --- |
| Account Home | Account-scoped persisted identity, plan, users, databases and explicitly read usage. Missing measurements remain unavailable. |
| Account resources | Stored plan limits remain distinct from per-account observations. Whole-server IO data is never an account usage projection. |
| Files, databases, DNS, certificates and terminal | Existing native controllers retain their API authorization and host preconditions. Read-only composed views do not impersonate those operations. |
| Mail accounts | Scoped service users and actual stored domain choices; existing authorized mailbox endpoints own mutations. |
| Mail inbox | The authenticated mailbox session, current account/service policy and folder control access. Live invalidations do not fabricate message UIDs or unread counts. |
| Preferences, mail collections and health | Unread differs from observed empty. Domain metadata does not prove DNS, SMTP, TLS or delivery health. |
| Account list and plans | Filters operate on authorized loaded rows. Plan edits use the stored plan and PATCH; creation uses POST. Submitted resource values use the displayed units. |
| Application catalog | Read-only pages inherit their canonical installer page's role and capability. Missing signed catalogs, job reads or installer services leave actions disabled. |
| Server analytics | One cached resource pipeline. A missing, stale, incomplete or unmeasured snapshot is unavailable, rather than a numeric zero. |
| Host limits and DNS | Enforcement requires assigned-plan values and actual device/unit evidence. Reconciliation compares actual prior zone content before reusing a serial. |
| Lifecycle | Privileged effects require persisted intent and the native root/FD/process ownership protocol. A parsed artifact or portable test cannot grant that authority. |

## Authentication modes

The startup process captures its trusted runtime policy once. `NODE_ENV=development` disables runtime two-factor challenges and enrollment actions while preserving stored factors, password verification, account/session authorization and recovery data. Production, an unset environment and an unknown environment use optional enrollment. Existing enrolled factors are enforced in that mode. Request headers, query parameters, cookies and bodies cannot switch modes. A development session does not acquire a persisted factor-verification claim.

## Verification layers

The CI jobs separate portable unit tests, HTTP boundaries, TypeScript checks, Chromium interface acceptance and dependency auditing. The account-file helper is compiled on Linux without executing it or granting privileges. Browser fixtures are synthetic and do not qualify hosting, SMTP delivery, DNS propagation, systemd isolation or lifecycle execution. Those require their separate native qualification environment and real observations.

Strict board evidence uses independent capture witnesses, exact dimensions, page and tile limits, all mandatory screens and a failing negative control. External reference inputs are prerequisites; missing inputs produce a blocked result. Screenshot equality or a diagnostic script exit is not an authenticity or production-readiness receipt.
