# xuapi and xwhmapi: the xPanel command-line API

`xuapi` runs account API functions (the account scope of the xPanel panel, like cPanel `uapi`).
`xwhmapi` runs server and reseller API functions (the xWHM scope, like cPanel `whmapi1`).
Both call the HTTP API of the running `xpanel-api` service through a local socket, so every call has the
same route confinement, authorization, job serialization and audit as the panel. They are separate from the
`xpanel` maintenance CLI (`apps/api/src/cli.ts`) and the `xpanel-ctl` lifecycle CLI.

## Usage

```
xuapi   [--user=<account>]  <Module> <function> [key=value | key:=<json> | key=@-] ...
xuapi   [--user=<account>]  <METHOD> <path>     [params]
xuapi   [--user=<account>]  list [<Module>]
xwhmapi [--reseller=<name>] <Module> <function> [params]
xwhmapi [--reseller=<name>] <METHOD> <path>     [params]
xwhmapi [--reseller=<name>] list [<Module>]
```

Examples:

```
xuapi cron list
xuapi cron create expectedRevision=<from cron list> schedule='*/5 * * * *' command='php run.php' enabled:=true
xuapi --user=alice domains list            # root only
xwhmapi accounts list
xwhmapi --reseller=bob accounts list       # root only
xuapi GET /api/account/site-health
printf '%s\n' "$PASSWORD" | xuapi database-engines postgresql_users_create name=alice_app password=@-
```

- `list` prints `Module function`, the HTTP method and the path template. The functions live in
  `functions.ts`; any route the listener admits also works as `<METHOD> <path>`.
- `{name}` placeholders in a path are filled from `name=value`. For xuapi, `{account}` and `{username}`
  default to the `--user` account or the calling account.
- `key=value` sends a string, `key:=<json>` a JSON value (number, boolean, array, object), and `key=@-`
  one value read from standard input. GET sends the parameters as the query string, other methods as a
  JSON object body.
- A password, passphrase, secret or token is refused on the command line; pass it with `key=@-`.

Output is one JSON document, `{"status":<http>,"data":<body>}` on success or
`{"status":<http>,"error":<problem>}` when the API refuses. A download (backup, CSV) is written raw to
standard output and its status to standard error.

| Exit status | Meaning |
|---|---|
| 0 | the API answered 2xx |
| 1 | usage error; nothing was sent |
| 2 | the API refused the call (4xx) |
| 3 | the API failed (5xx) or the service is unreachable |

## Identity and authorization

The service listens on `/run/xpanel-api/xuapi.sock` (the xPanel app) and `/run/xpanel-api/xwhmapi.sock`
(the xWHM app). Any local user may connect, including from the jailed shell and cron. The service reads the
caller's UID from the kernel (SO_PEERCRED) through the native verifier that the installer builds as
`/opt/xpanel/bin/xpanel-peer-identity.node`; without a verified build the sockets stay closed.

| Caller | xuapi | xwhmapi |
|---|---|---|
| a hosting account | acts as that account's owner; `--user` naming another account is refused (403) | refused (403) |
| root | requires `--user=<account>` and acts as that account, never as root | acts as root; `--reseller=<name>` acts as that reseller |
| any other user | refused (401) | refused (401) |

After the identity is resolved (`identity.ts`), the request goes through the normal path: the listener's
route confinement, offline mode, `assertRequestAuthorized` (forced password change, root-only routes,
reseller ACL, account status, plan features) and the handlers' ownership checks. Host effects run through
the same agent runners as the panel, as the account UID inside its slice. Root acting as an account or
reseller is recorded as the impersonator in every audit entry, and it cannot change the sign-in identity of
that account, as with a WHM "Log in to xPanel" handoff.

The command line carries no credentials: requests with a cookie or an `Authorization` header are refused,
and sign-in, sign-out, handoff and integration routes are not reachable. Operations that require an
interactive session (password and two-factor changes, API token and session management, terminals) are
refused as they are for API tokens. A kernel-identified caller is not asked for a second factor. The
panel-access IP allowlist filters network clients and does not apply to these local sockets.

The "Command-line API" plan feature (`command-line-api`) is enabled by default; disabling it in a feature
list refuses every xuapi call for accounts on that plan, including root's `--user` calls. Every process that
runs as the account UID, including its websites and cron jobs, can use xuapi while the feature is enabled.

Limits: request bodies up to 1 MiB, 32 connections per socket, 4 calls in flight per UID. Resellers have no
operating-system account, so only root can act as a reseller locally.

## Files

| File | Role |
|---|---|
| `client.ts` | the command-line client; only `node:` modules, so any user can run it |
| `functions.ts` | the `Module function` catalog of both commands |
| `socket.ts` | the local sockets in the API service |
| `identity.ts` | kernel UID and `--user` / `--reseller` to the acting principal |
| `/opt/xpanel/bin/xuapi`, `xwhmapi` | wrappers (`bin/` in the release), linked from `/usr/local/bin` |

Tests: `client.test.ts` and `functions.test.ts` (unit), `cli-api-security.test.ts` (HTTP layer over a real
socket), `socket.linux.test.ts` (kernel SO_PEERCRED, Linux lane).
