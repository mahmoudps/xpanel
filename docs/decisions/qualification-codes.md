# Criterion codes against the product's codes (2026-11-07)

The criteria in `packages/catalog/src/data/specs.ts` came from a research pass and name cPanel-style codes. The product has a
small closed vocabulary instead: `VALIDATION`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `LIMIT_EXCEEDED`, `PRECONDITION_FAILED`,
`UNAUTHENTICATED`, `LOCKED_OUT` and a few specific ones. A second name for the same refusal would add nothing, so every
corrected criterion uses that vocabulary. No driver aliases a code: a driver compares the code literally, and a wrong
correction here fails on a host instead of passing.

`VALIDATION_ERROR` became `VALIDATION` in every criterion. Driven tools are listed below; tools without a driver still
name their original codes until they get one.

## Product right: criterion corrected

Evidence is the refusal read in the tool's handler, or "slice review" where the review of that handler reported it. A slice
review entry is not confirmed until a host run passes.

| Tool | Criterion said | Now says | Evidence |
|---|---|---|---|
| `add-dns-zone` | `ZONE_EXISTS` | `CONFLICT` | slice review |
| `add-package` | `FORBIDDEN_UNLIMITED` | `FORBIDDEN` | rules/plans.ts:227 |
| `aapanel-third-party-plugin-import` | `INVALID_PACKAGE` | `VALIDATION`, reason `plugin_package_format` | plugin-packages.ts |
| `aapanel-go-project` | `NOT_EXECUTABLE` | `VALIDATION`, reason `NOT_EXECUTABLE` | account-runtime.ts |
| `aapanel-java-project` | `RUNTIME_MISSING` | `PRECONDITION_FAILED`, reason `RUNTIME_MISSING` | account-runtime.ts |
| `create-account` | `USERNAME_INVALID` | `VALIDATION` | rules/naming.ts |
| `create-domain` | `DOCROOT_INVALID` | `VALIDATION` | rules/domains.ts:87 |
| `delete-package` | `PACKAGE_IN_USE` | `CONFLICT` | store.ts:968 |
| `email-account-create` | `WEAK_PASSWORD` | `VALIDATION` | password-policy.ts:12 |
| `file-manager` | `ALREADY_EXISTS` | `VALIDATION` | slice review |
| `file-manager` | `PATH_OUTSIDE_HOME` | `FORBIDDEN` | file-manager.ts:146 |
| `file-text-editor` | `FILE_TOO_LARGE` | `VALIDATION` | slice review |
| `file-trash` | `TARGET_EXISTS` | `VALIDATION` | slice review |
| `ftp-accounts` | `PATH_OUTSIDE_HOME` | `VALIDATION` | slice review |
| `git-version-control` | `INVALID_CLONE_URL` | `VALIDATION` | account-git.ts:29 |
| `indexes` | `PATH_OUTSIDE_HOME` | `VALIDATION` | slice review |
| `ip-addresses-list` | `IN_USE` | `CONFLICT` | store.ts:3167 |
| `locale-xml-import` | `INVALID_FORMAT` | `VALIDATION` | slice review |
| `manage-account-suspension` | `ACCOUNT_SUSPENDED` | `FORBIDDEN` | server.ts:752 |
| `manage-domain` | `MAIN_DOMAIN_PROTECTED` | `PRECONDITION_FAILED` | store.ts:2040 |
| `modsecurity` | `FORBIDDEN` | `NOT_FOUND` | slice review |
| `multiphp-ini-editor` | `MISSING_PARAMETER` | `VALIDATION` | slice review |
| `mysql-databases` | `NAME_TOO_LONG` | `VALIDATION` | slice review |
| `mysql-users` | `NAME_TOO_LONG` | `VALIDATION` | slice review |
| `password-modification` | `WEAK_PASSWORD` | `VALIDATION` | password-policy.ts:12 |
| `password-security` | `INVALID_PASSWORD` | `UNAUTHENTICATED` | server.ts:2294 |
| `password-security` | `WEAK_PASSWORD` | `VALIDATION` | password-policy.ts:12 |
| `php-pear-packages` | `FEATURE_DISABLED` | `FORBIDDEN` | authorization.ts:231 |
| `remote-database-access` | `INVALID_NOTE` | `VALIDATION` | slice review |
| `reseller-account-limits` | `LIMIT_EXCEEDED` | `OVERSELL_BLOCKED` | slice review |
| `reseller-privileges` | `FORBIDDEN_ACL` | `FORBIDDEN` | rules/resellers.ts:35 |
| `restart-postgresql` | `NOT_INSTALLED` | `PRECONDITION_FAILED` | host-services.ts:154 |
| `system-reboot` | `CONFIRMATION_REQUIRED` | `VALIDATION` | slice review |
| `terminate-accounts` | `CONFIRMATION_REQUIRED` | `VALIDATION` | server.ts:3678 |
| `transfer-or-restore-account` | `ACCOUNT_EXISTS` | `CONFLICT` | transfer-workspace.ts:446 |
| `two-factor-auth` | `INVALID_TOTP` | `VALIDATION` | slice review |
| `webmail-attachments` | `ATTACHMENT_TOO_LARGE` | `PRECONDITION_FAILED` | slice review |
| `webmail-autoresponder` | `AUTORESPONDER_EXISTS` | `CONFLICT` | slice review |
| `webmail-autoresponder` | `INVALID_SCHEDULE` | `VALIDATION` | slice review |
| `webmail-email-filters` | `FEATURE_DISABLED` | `FORBIDDEN` | slice review |
| `webmail-folders` | `FOLDER_EXISTS` | `CONFLICT` | slice review |
| `webmail-folders` | `PROTECTED_FOLDER` | `CONFLICT` | folder-admin.ts:153 |
| `webmail-forwarders` | `FORWARD_LOOP` | `VALIDATION` | mailbox-forwarders.ts:147 |
| `webmail-identities` | `IDENTITY_NOT_OWNED` | `FORBIDDEN` | compose-identity.ts:59 |
| `webmail-signin` | `LOGIN_LOCKED` | `LOCKED_OUT` | server.ts:376 |
| `webmail-spam-autodelete` | `OUT_OF_RANGE` | `VALIDATION` | slice review |
| `webmail-two-factor` | `INVALID_TOTP` | `VALIDATION` | slice review |
| `webmail-two-factor` | `TOTP_REQUIRED` | `UNAUTHENTICATED` | slice review |
| `xpanel-tools-home` | `FEATURE_DISABLED` | `FORBIDDEN` | authorization.ts:231 |
| `xwhm-two-factor-auth` | `TOTP_INVALID` | `UNAUTHENTICATED` | slice review |
| `zone-editor` | `ZONE_SERIAL_MISMATCH` | `CONFLICT` | dns-workspace.ts:22 |

## Product wrong: closed

Every row of the former fix list, with what closed it. "Already held" means the product refused correctly and this list was
stale. These clauses have unit tests; none has passed on a host yet, so slice review caution applies until a run does.

| Tool | Criterion said | Returns | Closed by |
|---|---|---|---|
| `account-preferences` | `INVALID_PASSWORD` | `UNAUTHENTICATED` | `currentPassword` is required to change the address, on both themes |
| `add-package` | `NAME_RESERVED` | `VALIDATION` | rules/plans.ts refuses `extensions` |
| `basic-server-setup` | `NAMESERVERS_NOT_CONFIGURED` | `PRECONDITION_FAILED` | account creation refuses saved empty nameservers |
| `change-hostname` | `INVALID_HOSTNAME` | `VALIDATION` | already held: `validateServerHostname` in server-operations.ts |
| `create-account` | `DMARC_REQUIRES_SPF_DKIM` | `VALIDATION` | `spf`, `dkim`, `dmarc` options; the new zone omits SPF or DMARC when off. DKIM stays with the email-auth batch |
| `db-engine-upgrade` | `WARNINGS_NOT_ACKNOWLEDGED` | `PRECONDITION_FAILED` | apply needs `acknowledgedWarnings`; the confirm dialog sends them |
| `dns-zone-manager` | `RECORD_CONFLICT` | `CONFLICT` | `saveDnsZone` refuses a CNAME beside another record |
| `edit-package` | `IMMUTABLE_FIELD` | `VALIDATION` | PATCH refuses a changed name or IP flag; both are read-only in the editors |
| `email-account-create` | `QUOTA_EXCEEDS_MAX` | `LIMIT_EXCEEDED` | validate-state.ts; the plan cap is the account disk quota |
| `file-text-editor` | `ENCODING_ERROR` | `VALIDATION` | `write` takes `to_charset` and `fallback` for ISO-8859-1 and US-ASCII. The editor has a character set control on both themes, opens a single-byte file through `get-bytes` and refuses a byte or character outside the chosen set |
| `forwarders` | `LIMIT_EXCEEDED` | `LIMIT_EXCEEDED` | the cap no longer answers `CONFLICT` |
| `git-version-control` | `DEPLOY_DIRTY_TREE` | `CONFLICT` | op `deploy` runs `.cpanel.yml` tasks in the account jail and records the commit. Both themes have the Deploy button and show the last deployed commit |
| `initial-setup-wizard` | `ALREADY_COMPLETED` | `CONFLICT` | `POST /api/setup/wizard/complete`; the setup form keeps its own route |
| `list-parked-domains` | `DOMAIN_BLOCKED` | `FORBIDDEN` | already held: tweaks/domains.ts |
| `locale-delete` | `PROTECTED_LOCALE` | `CONFLICT` | the catalog route refuses the default language |
| `mail-queue-manager` | `NOT_FROZEN` | `CONFLICT` | already held; a deleted message now answers the criterion's `NOT_FOUND` |
| `modify-account` | `PACKAGE_CONFLICT` | `CONFLICT` | Every package limit, under its WHM name or its own, from `PATCH /api/accounts/:id` and the account details on both themes. Four resolutions act; `detach` refuses: see below |
| `php-pear-packages` | `SYSTEM_MODULE_PROTECTED` | `FORBIDDEN` | removal refuses PHP's own PEAR packages; install and remove already existed |
| `reseller-package-limits` | `FORBIDDEN_PACKAGE` | `FORBIDDEN` | already held: rules/resellers.ts |
| `restart-dns` | `SERVICE_DISABLED` | `PRECONDITION_FAILED` | a stopped service that boot disabled is refused |
| `restart-ftp` | `SERVICE_DISABLED` | `PRECONDITION_FAILED` | the same refusal |
| `track-dns` | `FEATURE_DISABLED` | `FORBIDDEN` | the saved root Traceroute setting now governs the owner tool |
| `transfer-or-restore-account` | `PATH_NOT_ALLOWED` | `VALIDATION` | already held: a filename with a path is refused. An existing target now answers `CONFLICT` before upload |
| `transfer-or-restore-account` | `AUTH_FAILED` | `FORBIDDEN` | discovery reports a refused credential |
| `transfer-tool` | `AUTH_FAILED` | `FORBIDDEN` | the same refusal |
| `upgrade-downgrade-account` | `FORBIDDEN_PACKAGE` | `FORBIDDEN` | already held: `changePlan` passes through `assertResellerCapacity` |
| `webmail-compose` | `SEND_RATE_LIMITED` | `LIMIT_EXCEEDED` | Tweak Setting `security.mailboxSendsPerHour`; counted in one API process |
| `webmail-mail-client-setup` | `INVALID_EMAIL` | `VALIDATION` | `POST .../send-instructions`, five messages per hour. Both themes have the send form, closed until a server hostname is read |
| `webmail-signin` | `ACCOUNT_SUSPENDED` | `FORBIDDEN` | only the right password learns the state; no session opens |
| `xwhm-api-shell` | `FEATURE_DISABLED` | `FORBIDDEN` | Tweak Setting `security.apiShell` |
| `xwhm-api-tokens` | `TOKEN_IP_DENIED` | `FORBIDDEN` | `requireCaller` refuses a live token outside its list |

## Rows that were wrong

| Tool | Criterion said | Why no fix |
|---|---|---|
| `backup-config` | `INVALID_PATH` | Archives are built beside their final file so publishing is one atomic link. A separate staging directory would give that up. Any `stagingDir` field is refused with `VALIDATION`, so the clause holds |
| `db-engine-upgrade` | `DOWNGRADE_NOT_SUPPORTED` | The product upgrades to the package manager's candidate and offers no target, so a downgrade cannot be requested. A `targetVersion` field is refused with `VALIDATION` |
| `dns-zone-manager` | `OPERATION_NOT_ALLOWED` | Adding SOA is refused by the record type check. The SOA is rendered from the zone and never stored, so no request can name it for deletion. The criterion now says so |
| `process-manager` | `PROTECTED_USER` | Root, the panel, kernel threads and service masters already refuse with `FORBIDDEN`. Workers under a system user stay signalable by an existing test, because their master respawns them |

`process-manager` has "Kill all for user X": `POST /api/server/monitoring/processes/kill-user`, root only, audited before the first
signal. Only a saved hosting account can be chosen, so root, service and panel users answer `FORBIDDEN`. It sends KILL and not TERM:
TERM is a clean exit to a `Restart=on-failure` unit, which would leave the account's PHP pool stopped. Helpers inside
`xpanel-agent.service` and `xpanel-api.service` stay, found by cgroup because an account chooses its own process names.

## `detach` stays a refusal

Two things carry this name, and neither can act here.

`detach` in the table above is the WHM package conflict answer "detach from any package". Here every account keeps a package: its
feature list, the dedicated IP rule, default mailbox quota, bandwidth enforcement and the reseller's allocation all read the plan,
`Account.planId` is required in the store, and about 430 places read it. A detached account would need a second source for each.
Faking it would be worse: an account that only hid its `planId` would still follow the package and still block deleting it. So
`detach` stays listed, because the criterion asks for five resolutions, and answers `PRECONDITION_FAILED` with reason
`package_required`. Both themes show it disabled. `create` gives the account the same result: its own package, which later edits of
the old one do not touch. `keep` holds single values on the account.

The cPanel action on a domain is Unpark on WHM List Subdomains (`list-subdomains`). It exists because cPanel builds an addon or alias
on a backing subdomain, so it can break that link and leave the subdomain. Here an addon is its own `Domain` record and an alias only
has a `parentId`: no backing subdomain exists, so there is no link to break. Removing the domain is the whole operation, and
`DELETE /api/domains/:id` already does it (`UNPARK-REMOVES-FROM-LIST` and `UNPARK-DELETES-ZONE` on `list-parked-domains`).

## Text corrected

- `account-transfer-progress` named cPanel states. It now names the product's session states.
- `dynamic-dns` said a call "from" an address and a 404 after rotation. The product takes `myip` under the dyndns2 protocol and answers `badauth`, which is the protocol's refusal.
- `server-health` said "passed". The product's state is `ok`.

## aapanel-default-site

Decision 9 and `w5-accounts` cover a bound site with an empty `public_html`. They do not answer unbound names, so the default-site clause stayed open. The policy now has a `site` response: nginx proxies unbound names to the backend with that domain as a fixed `Host`, so its vhost and suspension page apply. It is uncached, and it is the only default server allowed `proxy_pass`. HTTPS uses the fallback certificate.
