# Independent application entrypoints

The application starts one unprivileged process with one shared SQLite handle,
state store and privileged-agent client. Each immutable application profile has
its own private HTTP listener and independent HTTPS ingress. The public listener
ports are xPanel `2083`, xWHM `2087` and xMail `2096`.

| Profile | HTTPS origin example | Private listener | Interactive role |
| --- | --- | --- | --- |
| xPanel | `https://panel.example.test:2083` | `127.0.0.1:12083` | Account user |
| xWHM | `https://whm.panel.example.test:2087` | `127.0.0.1:12087` | Root or reseller |
| xMail | `https://mail.panel.example.test:2096` | `127.0.0.1:12096` | Account user |

xMail authenticates the account's existing control-plane identity. This does not
implement or qualify mailbox credentials, SMTP/IMAP delivery, or a live mailbox.

## Required configuration

Before enabling the API, populate all three origins in `/etc/xpanel/api.env`:

```dotenv
XPANEL_HOST=127.0.0.1
XPANEL_PANEL_PORT=12083
XPANEL_WHM_PORT=12087
XPANEL_MAIL_PORT=12096
XPANEL_PANEL_PUBLIC_ORIGIN=https://panel.example.test:2083
XPANEL_WHM_PUBLIC_ORIGIN=https://whm.panel.example.test:2087
XPANEL_MAIL_PUBLIC_ORIGIN=https://mail.panel.example.test:2096
XPANEL_SERVER_SECRET_FILE=/etc/xpanel/server.secret
XPANEL_INGRESS_SECRET_FILE=/etc/xpanel/ingress.secret
```

Replace the example names with the exact deployment names. Origins must be
canonical HTTPS origins, including the required port, without credentials,
paths, queries, fragments or trailing slashes. Startup validates the entire
configuration before opening the database. It fails closed when an origin is
missing, a port collides, the bind is not explicit loopback, or a production
backend does not use its fixed reserved port. A failure after a listener binds
closes all opened listeners, subscriptions and database resources. It never
falls back to a shared login server.

The installer provisions `ingress.secret` with the same protected credential
contract as the server secret: root-owned, group `xpanel`, mode `0640`, under
root-owned `/etc/xpanel`. Existing credentials are preserved. Existing `api.env`
files are also preserved and must be migrated explicitly. No secret value belongs
in a source file, environment example, command argument, report or build log.

## TLS ingress

`entrypoints.conf.example` is a generic nginx HTTP-context example, not an
installed or live-qualified configuration. Review all of these before deployment:

1. Back up the existing ingress configuration, API environment and service unit
   beside the originals using a timestamp. Record the currently active release
   and listening sockets. Keep the existing listener until the new release,
   environment, health checks and rollback procedure are ready.
2. Use trusted certificates valid for each reviewed name. A wildcard certificate
   covers only one label level; a certificate for `*.example.test` does not cover
   `whm.panel.example.test`. Include all required SANs or use separate certificates.
   Keep TLS private keys outside the API service identity's read permissions.
3. Replace the documentation address `192.0.2.10` with the exact public interface
   address. Avoid wildcard bindings that conflict with an existing loopback
   service on `2087`. Inspect IPv4 and IPv6 listeners before changing either.
4. Create a root-owned, mode `0600`, non-published
   `/etc/nginx/xpanel/ingress-secret.conf`. Its only directive is
   `proxy_set_header X-XPanel-Ingress-Secret "<protected value>";`, with the value
   read privately from the protected credential file. Validate its format first,
   disable shell tracing, and do not log the generated directive. The nginx
   master must read this protected include. The API loads the matching credential
   from its protected file. Never trust a browser-provided ingress header.
5. Each virtual server must preserve the exact public `Host` including port,
   replace forwarded protocol with `https`, and replace forwarded client identity
   with the immediate connection peer. The application rejects a mismatched
   public host and uses the protected ingress credential before trusting TLS or
   forwarded client identity. Do not add a second ingress hop without reviewing
   the real-client identity contract.
6. Validate with `nginx -t` before a reload. Open only public `2083`, `2087` and
   `2096` in the management firewall. Keep `12083`, `12087` and `12096` bound to
   loopback and unavailable to tenant TCP forwarding, tenant proxies and the
   public network. Local HTTP listeners do not provide TLS themselves.
7. Test each trusted HTTPS login, wrong-host rejection, wrong-role rejection,
   session replay across all three ports, CSRF/origin checks, sign-out, MFA,
   password-change flows, and HTTP/WebSocket confinement before retiring the old
   entrypoint. A browser naturally sends same-host cookies to multiple ports;
   separate cookie names alone do not isolate sessions. Stored session credential
   hashes are audience-bound and enforced at authentication.

Render-only installer tests, loopback HTTP tests and synthetic browser UI tests
are limited evidence. Public TLS, the live firewall and installed service
lifecycle require their own target-host evidence. These entrypoints do not
change the project's prelaunch readiness decision.
