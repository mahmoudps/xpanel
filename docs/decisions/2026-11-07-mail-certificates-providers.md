# Mail campaigns, outbound holds, provider records and scheduled certificates (2026-11-07)

Everything scheduled here runs from one minute timer inside the API service (`apps/api/src/mail-cert-scheduler.ts`),
like the alert schedule: no daemon, no timer unit, never two ticks at once, one writer admission per tick. A failed
part is retried by the next tick and never stops the others. Scheduled work calls the agent as the built-in root
principal, like the administrative command line.

## AutoSSL

The host-derived nightly hour (01:00 to 05:00 UTC) keeps a fleet from reaching the CA at once. A nightly run queues
domains with no certificate and ACME certificates inside `renewDays`; the same scan looks for new domains each tick,
so a new site waits a minute, not a day. One order is placed per tick, so a large host never loads the single vCPU or
the CA. A CAA refusal (RFC 8659 tree climb) skips the name, and a name that does not resolve is deferred, in both
cases with no order: the CA limits failed validations per host name. A failed order waits 1, 2, 4, then 8 days.
Uploaded certificates stay untouched unless replacement is on and they are expired or within 3 days of expiry.
Run state lives in `extended/tls/autossl-state.json` with 30 days of results; the policy is a `sec` kind.

## Outbound spam protection

Counters come from the mail log, read once each minute (`/host/mail/log/outcomes`), not from a policy service in the
mail path: a failed or slow counter can never delay or refuse mail, and no socket needs an SELinux rule. The price is
that detection follows the log by up to a minute. Recipients delivered to other servers count, including every BCC.
Holding is `check_sender_access` with `HOLD` in `smtpd_data_restrictions`, which every smtpd service reads and master.cf
does not override, plus a `header_checks` rule on the `Received: by ... from userid N` line pickup(8) adds, so a PHP
`mail()` call is held by account UID, which a sender cannot choose. The tables are a mail policy section, so a hold goes
through the tested apply path with its rollback. A release resets the counters of that sender, or it would hold again at
once. Campaign mail is identified by its Message-ID and does not count: root chose to send it.

## Mail campaigns

Sending stays in the local MTA over loopback at the rate of each campaign, so Postfix limits, DKIM signing and the
queue apply as to any other mail. The sender must be at a hosted domain. The cursor is an address, not an index:
someone unsubscribing mid-send must not shift who comes next. `Message-ID: <xpm-...>` ties log results back to a campaign
or flow. Bounced and expired addresses join the suppression list.

The unsubscribe link is a signed capability for one address in one group. It lives at `/mail/unsubscribe`, outside
`/api/`, because RFC 8058 one-click is a form POST, and it passes before the panel access allowlist, because a recipient is
not a panel user. GET only shows a button, so a link scanner cannot unsubscribe anyone.

Open and click counters are left out on purpose: they would need a tracking pixel and rewritten links in customer mail.

## Notification templates

A saved template replaces the product text for one event. Account notices follow the audit log, so every path that
performs the action sends the notice, and a first run starts at now, so history is never mailed. A quota warning goes
out once a month per account at 90%. Accounts have no language setting, so notices use the English version until they do.

## Provider records and automatic DNS

Every write to Cloudflare is read back, and a difference is reported as unverified. Automatic DNS never fails a site
creation: its outcome is returned beside the created domain. The address must be public, and a record that points
elsewhere is left alone, because replacing it could take a live site away from another server.

## Web Disk TLS

nginx takes `ssl_protocols` of a listener from its default server, so the saved lists render on the account servers and
on the default server of ports 2078 and 2080. TLS 1.2 is the floor: anything lower is refused as VALIDATION.
