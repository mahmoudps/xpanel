# Services, processes and security centre (2026-11-07)

Scope: Web Server Status, Daily Process Log, Background Process Killer, System PHP-FPM, PHP domains, PEAR, ClamAV scanner
configuration, Outbound SMTP Restrictions, Traceroute Access, Shell Fork Bomb Protection, ModSecurity rules and vendors,
the Logging, Security, Status, Support and Software Tweak Settings, the Change Log and Piped Logging. Each row of
`packages/catalog/src/host-qualification.ts` states what is delivered and what is not.

## Shared shape

Saved policies are `SecKind`s (`apps/agent/src/svc-policy.ts`), written through the revision-bound sec workspace, so every
tool gets the same conflict check, read-back and audit. Panels are one theme-free schema (`apps/web/src/svc-panels.ts`) drawn
by each theme and bound by one client. A new tool is a parser, a table row and a panel entry.

Background work runs in the agent's existing minute timer: no new daemon, timer unit or polling loop.

## Choices

- **Web status.** Hosting accounts can reach the loopback Apache port, and the mod_status scoreboard shows other accounts'
  request lines. The status path therefore carries a 256-bit token from a root-only file, in an include of mode 0640.
  `Require local` alone would not be enough. nginx `stub_status` shows only counters, so it sits on a unix socket.
- **Fork bomb protection.** cPanel uses `/etc/profile.d`, which a non-login `ssh host cmd` skips. `pam_limits` covers every SSH
  session, and terminal units get the same values as systemd properties because no PAM session starts there. The page reports
  `pam_missing` when PAM does not load the module or `sshd_config` sets `UsePAM no`, so the switch never claims protection the host does not enforce. Linux does
  not enforce RLIMIT_RSS, so that row of the cPanel list is left out.
- **SMTP restrictions.** A rule on account UIDs (`MIN_ACCOUNT_UID`..`MAX_ACCOUNT_UID`) needs no lookup of the MTA's user, so a
  renamed or absent system user cannot block mail. `oif lo` keeps local delivery, including this host's public addresses, open.
- **Pool defaults.** A domain "has not chosen its own values" when its pool still equals the release values (`DEFAULT_FPM`),
  so no schema change was needed. Returning a domain to the defaults restores those values.
- **WAF rules.** `SecRuleEngine` is deployed with the rules. A distribution default of DetectionOnly logs but does not block,
  and the page says so. Rule files refuse `exec:`, `@inspectFile`, `SecRuleScript`, `Include` and the directives that move the
  engine's own files. The acceptance needs the connector, which is not installed by default; deploy refuses with
  `waf_connector_unavailable` rather than saving rules that protect nothing.
- **WAF vendors.** A cPanel `meta_<vendor>.yaml` file is read with the failsafe YAML schema: the newest listed ModSecurity version, `SHA512` and a `.zip` holding one `<vendor>` directory, as cPanel documents. `SHA512` is required, because MD5 is no pin and FIPS hosts refuse it. A JSON document pins one gzip tar by SHA-256. The archive is read
  in process, so links, devices and traversal never reach the host.
- **Change log.** The publisher manifest refuses unsigned fields, and installed agents parse it strictly, so adding notes to it
  would break the upgrade chain. The notes file ships in the release tree, covered by the manifest digest. No release script changed.
- **Session address validation.** Default strict, as cPanel. An address unknown on either side is not compared.
- **Tweak keys.** Only keys with a real consumer ship (owner decision D6). Successful sign-ins are always audited, so that
  setting would have no effect and has no key.
