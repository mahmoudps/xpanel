# Panel access: port, host name, entrance, basic authentication, temporary links

Date: 2026-11-07

## What was built

`/whm/security/panel-access` now holds every control of the aaPanel security set, on top of the existing allowlists.

| Control | Enforced by | State |
|---|---|---|
| Allowlist | API gate | `extended/server/sec-panel-access.json` |
| Entrance, unauthenticated response, basic authentication, stopped entry points | API gate (`apps/api/src/panel-gate.ts`) | `extended/server/sec-panel-gate.json` |
| Temporary links | Session check and `requireCaller` | `extended/server/sec-panel-temporary-logins.json` |
| Port and host name per entry point | Management ingress and `api.env` | `/etc/xpanel/management-access.json`, root only |

## Decisions

**The gate never authenticates.** Each pass only reaches the normal sign-in or session check. The pass cookie is signed with the server secret and bound to the entry point, the entrance and the basic credential, so changing either ends earlier passes.

**Machine routes stay outside the gate.** `/api/health`, the DAV authorization, WHMCS, dynamic DNS, scheduler hooks, DNS cluster members, the handoff consumer and the temporary link carry their own credential. A valid API token, which is how linked servers call each other, passes basic authentication as it passes the entrance. Management TLS readiness needs health, so the gate can never break an upgrade check.

**Basic authentication runs in the API, not nginx.** nginx would need an exception per machine route and a second password file. A pass cookie keeps Argon2 off the hot path, and failures per address are bounded so a scanner cannot spend the only CPU.

**An unreadable rules file closes the listener.** This matches the allowlist. `xpanel panel-access reset all` treats a broken file as defaults, so the owner can always repair it from the shell.

**The entrance is opt-in.** aaPanel generates one at install, but `install` verifies `/login`, and an unknown secret at first boot helps nobody on a host the owner has not seen yet.

**A move has one transaction and a keep-or-revert window.** The agent only writes what should happen next (`management-access.next.json`) and starts `xpanel-management-tls.service`. That lifecycle already owns the ingress, `api.env`, the certificate and their rollback, so a move is one more phase of it, `rebind`, and not a second writer. The order is:

1. Validate: the grammar, then a real exclusive bind for `PORT_IN_USE`.
2. Open the new port in the firewall through a normal reconcile. A refused firewall stops here.
3. `rebind`: DNS check, certificate if the names changed, `nginx -t`, reload, restart agent and API, TLS and health check on every entry point. Any failure restores every file and the panel stays where it was.
4. The owner keeps the address from the new URL within 10 minutes. Otherwise the agent's minute tick runs `rebind` back to the previous address. A host can only prove what it reaches from itself, and this window is what proves the cloud firewall.

The next-file is consumed once. A refused change cannot retry on the renewal timer.

**The saved firewall list is not edited.** A moved port gets a rule generated at render, so no later edit of the saved list can drop it. `settings.panelPort` stays the firewall seed, and the page reads the listener's real origin from `api.env`.

**A temporary session is read-only.** It is a session of the issuer marked `temporary:<id>` through the handoff impersonator columns, which already refuse terminals, tokens, handoffs and identity changes and already check liveness per request. Writes, these settings, downloads and exports are refused, and each API call is written to the audit log under that actor, which is the separate activity log. Sessions that change things would need an allowlist of safe operations nobody has reviewed.

**The link spends on POST.** A preview bot fetches GET only.

## Root recovery

| Situation | Command, as root |
|---|---|
| Show the entrance and rules | `xpanel panel-access show` |
| Clear a part or everything | `xpanel panel-access reset <allowlist\|entrance\|response\|basic-auth\|stopped\|temporary-logins\|all>` |
| Return the default ports and host names | `node /opt/xpanel/current/scripts/management-tls.mjs reset-access` |

Two-factor authentication stays optional and is untouched here.

## Not built

- Binding a bare IP address.
- Temporary sessions that can change anything.
- A firewall reconcile right after an automatic revert: the unused port closes at the next reconcile, and nothing listens on it meanwhile.
- A proof that the cloud provider allows the new port: only the owner's own browser in the keep window can show that.
