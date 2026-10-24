// xPanel-native tools: capabilities with no public cPanel/aaPanel equivalent
// to take as-is (CSF/LFD-style detection, live monitors, health centers, CageFS-style isolation).
// Behavior is our own design, built on per-account systemd slices, nftables and the reconciler.
import type { ToolDefinition, ToolSpec } from '../types.ts'
import { absorbedIntoNative } from './absorbed.ts'

interface NativeTool {
  tool: Omit<ToolDefinition, 'status'>
  behaviors: string[]
  acceptance: string
}

const whm = (id: string, groupId: string, name: string, entity: string, summary: string): NativeTool['tool'] =>
  ({ id, surface: 'xwhm', groupId, name, summary, featureKey: null, resellerAcl: null, rootOnly: true, entity })

const panel = (id: string, groupId: string, name: string, entity: string, summary: string): NativeTool['tool'] =>
  ({ id, surface: 'xpanel', groupId, name, summary, featureKey: id, resellerAcl: null, rootOnly: false, entity })

const NATIVE: NativeTool[] = [
  {
    tool: whm('intrusion-detection', 'whm-security-center', 'Intrusion detection', 'ban',
      'Watches login failures across SSH, FTP, mail, the panel and web logins and bans attacking addresses in the nftables ban set.'),
    behaviors: [
      'Per-service failure thresholds and time windows (SSH, FTP, IMAP/POP3, SMTP AUTH, panel, webmail, custom log patterns)',
      'Temporary ban with escalating duration; permanent ban after N temporary bans within a period',
      'Distributed-attack detection: many addresses failing against one account within a window',
      'Port-scan detection from dropped-packet logs',
      'Allow list that is never banned (always includes the current admin session address)',
      'Ban list with reason, service, first/last seen, expiry; unban and convert to permanent',
      'Email and panel notifications with rate limiting',
      'Import allow/deny lists from an existing CSF installation (csf.allow, csf.deny) during migration',
    ],
    acceptance: 'Six failed SSH logins from one address inside the window add it to the nftables ban set with the configured expiry, while an address on the allow list is never banned.',
  },
  {
    tool: whm('flood-protection', 'whm-security-center', 'Connection & flood protection', 'firewall-rule',
      'Limits connections per address and per port, rate-limits new connections and protects against SYN and ICMP floods.'),
    behaviors: [
      'Per-port new-connection rate limits (e.g. 22, 25, 80, 443) with burst',
      'Concurrent connections per source address per port',
      'SYN flood protection and ICMP rate limits',
      'Exempt addresses and prefix lists',
      'Live counters of dropped packets per rule',
      'Rules rendered into the same nftables generation and refused if they would lock out the session',
    ],
    acceptance: 'A per-address limit of 20 concurrent connections to port 443 renders an nftables meter rule, and a rule set that would drop the current session address is refused with SELF_LOCKOUT.',
  },
  {
    tool: whm('traffic-monitor', 'whm-server-status', 'Traffic monitor', 'traffic',
      'Live and historical HTTP and network traffic per server, account and domain from Nginx logs and interface counters.'),
    behaviors: [
      'Live requests per second, bandwidth in/out and active connections for the server',
      'Top accounts, domains, client addresses, URLs and user agents for a chosen window',
      'Status code breakdown with 4xx/5xx spikes highlighted',
      'Live log tail filtered by domain, address or status',
      'One-click actions from a row: ban address, rate-limit path, open account',
      'History at 1-minute resolution for 24 h and 1-hour resolution for 30 days',
    ],
    acceptance: 'Requests written to an account domain access log appear in that domain row within one refresh interval, with counts matching the log lines.',
  },
  {
    tool: whm('io-monitor', 'whm-server-status', 'IO monitor', 'io-usage',
      'Per-account disk IO bandwidth, IOPS and throttling from each slice, with the processes behind it.'),
    behaviors: [
      'Read/write bytes per second and IOPS per account slice from cgroup io.stat',
      'Time spent throttled against the plan caps (io.pressure) and cap-hit events',
      'Top IO processes inside a selected slice',
      'Device-level totals and queue depth',
      'Sort and filter by plan, owner and reseller',
      'Marks accounts whose IO caps are not enforced because the io controller is missing',
    ],
    acceptance: 'A write loop inside an account slice capped at 10 MB/s shows a write rate at or below the cap and a non-zero throttled time for that account.',
  },
  {
    tool: whm('resource-limits-manager', 'whm-system-health', 'Resource limits manager', 'slice',
      'Server-wide view of every account slice: applied CPU, memory, processes and IO limits, current usage, fault counts and history.'),
    behaviors: [
      'Table of accounts with plan limits, applied limits and live usage side by side',
      'Fault counters per account (memory OOM kills, process cap hits, IO and CPU throttling)',
      'Temporary per-account override with expiry and reason, written to the audit log',
      'History charts per account for CPU, memory, processes and IO',
      'Top consumers over the last hour and day',
      'Reports fields this host cannot enforce',
    ],
    acceptance: 'Lowering an account memory limit through an override applies MemoryMax to its slice without restarting its services, and the override expires back to the plan value.',
  },
  {
    tool: whm('account-isolation', 'whm-security-center', 'Account isolation', 'account',
      'Per-account filesystem isolation for shells, cron and app processes: private /tmp, hidden other homes and a minimal system view.'),
    behaviors: [
      'Per-account mount namespace: only its own home, private /tmp and read-only system paths visible',
      'Applies to SSH jailed shells, cron timers, PHP-FPM pools and Node/Python/Ruby apps',
      'Skeleton of allowed binaries for jailed shells, editable by root',
      'Per-account exceptions with reason',
      'Verification button that proves the account cannot list /home or read another account file',
    ],
    acceptance: 'Inside account alice’s isolated shell, listing /home shows only alice and reading a file of account nour fails with permission denied.',
  },
  {
    tool: whm('server-health', 'whm-system-health', 'Server health', 'health-check',
      'One page of health checks for the host, each with status, evidence and a fix.'),
    behaviors: [
      'Disk space and inodes per filesystem, memory, swap, load, CPU steal',
      'Time synchronisation, hostname and reverse DNS, resolver reachability',
      'Server IP on public mail blocklists',
      'Pending OS security updates and reboot-required flag',
      'cgroup v2 controllers present (cpu, io, memory, pids) and quota support on /home',
      'Reconciler drift: desired state equals applied generation',
      'Backup recency and last restore test',
      'Certificates expiring within 30 days',
      'Exposed ports compared with the firewall policy',
      'Score with critical / warning / passed counts and a history',
    ],
    acceptance: 'With /home above 95% used the disk check reports critical with the filesystem, used and free values, and returns to passed once usage drops below 80%.',
  },
  {
    tool: whm('account-health', 'whm-system-health', 'Account health', 'health-check',
      'Health score per account with the reasons: limits, errors, SSL, DNS, mail authentication, PHP version and backups.'),
    behaviors: [
      'Score per account with critical / warning / passed checks',
      'Quota and limit pressure (80% / 95%) and recent limit faults',
      '5xx error rate and PHP fatal errors in the last 24 h',
      'SSL validity and coverage of every domain',
      'DNS records point to this server; SPF, DKIM and DMARC present',
      'End-of-life PHP versions in use',
      'Virus scanner findings and suspicious processes',
      'Last successful backup',
      'Filter to unhealthy accounts, sort by score, open the account with the failing check focused',
    ],
    acceptance: 'An account whose only domain has an expired certificate shows a critical SSL check with the domain and expiry date, and a valid certificate clears it.',
  },
  {
    tool: whm('service-config-health', 'whm-service-configuration', 'Service configuration health', 'health-check',
      'Validates the live configuration of every service and compares it with the desired state and a security baseline.'),
    behaviors: [
      'Runs each service checker: nginx -t, apachectl configtest, php-fpm -t per pool, postfix check, doveconf -n, pdns config check, sshd -t, nft -c, MariaDB config check',
      'Lists failed and degraded systemd units with their last log lines',
      'Drift: files that differ from the active config generation, with a diff and "re-apply generation"',
      'Security baseline: TLS 1.2 minimum, no weak ciphers, server tokens off, SSH root password login off, panel on TLS',
      'Each finding with evidence, risk and a one-click fix that goes through the reconciler',
    ],
    acceptance: 'A manual edit to a rendered Nginx vhost is reported as drift with a diff against the active generation, and "re-apply generation" restores the file and passes nginx -t.',
  },
  {
    tool: panel('account-health-overview', 'metrics', 'Site health', 'health-check',
      'The account owner’s health checks for their own sites: limits, errors, SSL, DNS, mail authentication, PHP and backups.'),
    behaviors: [
      'Same checks as the server-side account health, scoped to the owner’s account',
      'Each failing check explains the cause in plain language and links to the page that fixes it',
      'Shows on the home page as the "Needs attention" strip (up to three items)',
    ],
    acceptance: 'When a mailbox domain lacks a DMARC record, the owner sees a warning with an "Add DMARC record" action that opens the zone editor prefilled.',
  },
  {
    tool: panel('traffic-monitor-account', 'metrics', 'Live traffic', 'traffic',
      'Live requests, bandwidth, top pages, top visitors and errors for the owner’s own domains.'),
    behaviors: [
      'Live requests per second and bandwidth for each domain of the account',
      'Top URLs, client addresses, referrers and user agents',
      'Status code breakdown and recent 5xx with paths',
      'Block an address or rate-limit a path for the owner’s own domains',
    ],
    acceptance: 'The owner only ever sees traffic for domains of their own account; a request for another account’s domain is refused with NOT_FOUND.',
  },
  {
    tool: whm('trusted-proxies', 'whm-server-configuration', 'Trusted proxies', 'proxy-range',
      'Which upstream proxies (Cloudflare, load balancers) may set the real client address, so logs, bans and limits see the visitor, not the proxy.'),
    behaviors: [
      'Lists of trusted CIDR ranges per source: Cloudflare (refreshed automatically from its published ranges), custom load balancers',
      'Header per source: CF-Connecting-IP, X-Forwarded-For (rightmost untrusted hop), or PROXY protocol',
      'Rendered into Nginx real_ip and Apache mod_remoteip in the same config generation',
      'Addresses outside the trusted ranges can never spoof the client address',
      'Preview: what client address a sample request from each range resolves to',
    ],
    acceptance: 'A request from a Cloudflare range carrying CF-Connecting-IP 198.51.100.9 is logged and rate-limited as 198.51.100.9, while the same header from an untrusted address is ignored.',
  },
  {
    tool: whm('cloudflare-integration', 'whm-dns-functions', 'Cloudflare', 'integration',
      'Server-level Cloudflare connection: sync zones, proxy status, SSL mode and cache purge for accounts that opt in.'),
    behaviors: [
      'Connect with a scoped API token stored encrypted; test connection',
      'Choose which accounts may connect their domains',
      'Zone sync from PowerDNS to Cloudflare with a diff before apply',
      'Per-record proxied / DNS-only toggle, SSL mode (Full strict recommended) and cache purge',
      'Enables trusted-proxy ranges automatically when a domain is proxied',
      'Sync status and last error per zone',
    ],
    acceptance: 'Syncing a zone sends only the records that differ (shown in the diff), and a failed API call leaves PowerDNS unchanged with the error shown on that zone.',
  },
  {
    tool: panel('cloudflare-account', 'domains', 'Cloudflare', 'integration',
      'Connect the owner’s own Cloudflare account to their domains: DNS sync, proxy on/off, SSL mode and cache purge.'),
    behaviors: [
      'Connect with the owner’s scoped API token (stored encrypted, never shown again)',
      'Pick domains to manage; zone diff before each sync',
      'Proxy toggle per record, SSL mode, development mode, purge everything or by URL',
      'Warnings when the origin certificate would break Full (strict)',
    ],
    acceptance: 'An owner can only connect domains of their own account; attaching another account’s domain is refused with NOT_FOUND.',
  },
  {
    tool: whm('mail-monitor', 'whm-email', 'Mail monitor', 'mail-flow',
      'Live mail flow for the server: accepted, delivered, deferred, bounced and rejected messages, queue size and top senders.'),
    behaviors: [
      'Per-minute counts of inbound and outbound mail by outcome',
      'Queue size and oldest message age with a link to the queue manager',
      'Top sending accounts, mailboxes and recipient domains in a window',
      'Spikes flagged against each account’s normal volume',
      'Server IPs on public blocklists with delisting links',
      'Search a message by sender, recipient or message ID across logs',
    ],
    acceptance: 'A burst of 500 outbound messages from one mailbox within 10 minutes appears as a spike for that account and links to its messages in the queue.',
  },
  {
    tool: whm('outbound-spam-protection', 'whm-email', 'Outbound spam protection', 'mail-policy',
      'Per-account and per-mailbox sending limits that hold suspicious outbound mail before it harms the server reputation.'),
    behaviors: [
      'Hourly and daily send limits per plan, account and mailbox',
      'Automatic hold of the queue for an account that exceeds its limit or trips spam scoring, with notification',
      'Release or delete held messages after review',
      'Content scoring of outbound mail with the same spam engine',
      'Audit entry for every hold and release',
    ],
    acceptance: 'A mailbox that exceeds its hourly limit has further messages held (not sent) and the account owner and root are notified; releasing them delivers the held messages.',
  },
  {
    tool: whm('mail-quality', 'whm-email', 'Mail quality', 'mail-quality',
      'Reputation and authentication health of all mail domains, DMARC aggregate reports and spam-filter accuracy.'),
    behaviors: [
      'Per-domain score: SPF, DKIM and DMARC alignment, rDNS and HELO match, TLS, blocklists',
      'DMARC aggregate report ingestion and charts of pass/fail by source',
      'Spam filter accuracy from user corrections (marked spam / not spam) and Bayes retraining status',
      'One-click fixes that write DNS records through the zone editor',
    ],
    acceptance: 'A domain missing its DKIM record scores below passing with "DKIM missing" as the reason, and publishing the record from the fix action raises the score after the next check.',
  },
  {
    tool: panel('spam-quarantine', 'email', 'Spam quarantine', 'quarantined-message',
      'Review mail the spam filter held, release false positives and teach the filter from corrections.'),
    behaviors: [
      'List of quarantined messages per mailbox with score, reason and preview of headers',
      'Release to inbox, delete, or always allow the sender',
      'Every release counts as a "not spam" correction and every manual "mark as spam" as a spam correction for the account’s Bayes database',
      'Per-mailbox quarantine retention and digest email',
    ],
    acceptance: 'Releasing a quarantined message delivers it to the inbox and records a not-spam correction for that mailbox’s filter.',
  },
  {
    tool: whm('smtp-relay', 'whm-email', 'SMTP relay (smarthost)', 'integration',
      'Send outbound mail through an external relay for the whole server or chosen domains.'),
    behaviors: [
      'Relay host, port, TLS mode and credentials (stored encrypted); test send',
      'Scope: whole server, selected accounts or selected domains',
      'Fallback to direct delivery or hold when the relay fails',
      'Rendered into Postfix transport and SASL maps in the same generation',
    ],
    acceptance: 'With a relay scoped to alice-shop.com, mail from that domain goes through the relay while mail from other domains is delivered directly.',
  },
  {
    tool: whm('integrations-hub', 'whm-development', 'Integrations', 'integration',
      'All third-party connections in one place: billing, Cloudflare, backup storage, SMTP relay, notification channels and webhooks.'),
    behaviors: [
      'Card per connector with status, last success, last error and a test button',
      'Credentials stored encrypted, scoped API tokens for inbound integrations',
      'Webhook subscriptions for account, domain, backup and security events with signed payloads and retries',
      'Disconnect removes stored credentials immediately',
    ],
    acceptance: 'A webhook for account.created receives a signed payload when an account is created, and a failing endpoint is retried with backoff and shown as failing on its card.',
  },
  {
    tool: whm('whmcs-integration', 'whm-development', 'WHMCS', 'integration',
      'Provision and manage hosting from WHMCS with xPanel’s own provisioning module and a scoped API token.'),
    behaviors: [
      'Downloadable WHMCS server module (create, suspend, unsuspend, terminate, change package, change password, usage update, single sign-on)',
      'Scoped API token per WHMCS install, optionally IP-bound',
      'Package (plan) names mapped to xPanel plans',
      'Single sign-on links that open xPanel as the client without a password',
      'Activity log of every call from WHMCS',
    ],
    acceptance: 'A create call from WHMCS with a valid scoped token creates the account on the mapped plan, and the same call with a token lacking the create scope is refused with FORBIDDEN.',
  },
  {
    tool: whm('database-tuning', 'whm-sql-services', 'Database tuning', 'db-service',
      'Analyses the MariaDB and PostgreSQL services and recommends, previews and applies the best configuration for this host.'),
    behaviors: [
      'Reads live status and variables (buffer pool hit rate, temp tables on disk, connections used/max, slow queries, table cache misses, lock waits)',
      'Recommendations sized from host memory, cores, disk type and workload, each with the evidence and expected effect',
      'Preview the config diff; apply through the reconciler with a config test and automatic rollback if the service fails to start',
      'Slow query log on/off with threshold; top slow query patterns',
      'History of applied changes in the audit log',
    ],
    acceptance: 'With 8 GB RAM and a buffer pool of 128 MB the tuner recommends a larger innodb_buffer_pool_size with the reason, and applying it writes a new generation that passes the service config test before the restart.',
  },
  {
    tool: panel('database-insights', 'databases', 'Database insights', 'database',
      'Size, growth, slow queries, missing indexes and table health for the owner’s own databases, with optimise and repair actions.'),
    behaviors: [
      'Size and growth per database and table, rows and index size',
      'Slow queries of the account’s databases from the server slow log, normalised and ranked',
      'Index suggestions for frequent full scans',
      'Optimise, analyse and repair tables as a background job with progress',
      'Only the account’s own databases are ever visible',
    ],
    acceptance: 'An owner sees slow queries only for databases prefixed with their username, and optimising a table runs as a job that reports completion.',
  },
  {
    tool: whm('alert-rules', 'whm-system-health', 'Alerts', 'alert-rule',
      'Rules that turn health checks, service failures, security events and limits into notifications, with deduplication and maintenance windows.'),
    behaviors: [
      'Built-in rules: service down or restarting in a loop, failed config test, reconcile drift, disk / inode / memory / load thresholds, certificate expiring, backup failed or overdue, server IP blocklisted, intrusion bans spike, account over 95% of a limit',
      'Custom rules on any monitored metric with threshold, duration and severity',
      'Routing per severity to channels; reseller-scoped routing for reseller-owned accounts',
      'Deduplication, re-notify interval, resolve notification when the condition clears',
      'Maintenance windows that silence chosen rules',
      'Alert history with acknowledgement and who acknowledged it',
    ],
    acceptance: 'Stopping the nginx unit raises a critical "service down" alert to the configured channels once (not on every check), and starting it again sends a single resolved notification.',
  },
  {
    tool: whm('notification-channels', 'whm-system-health', 'Notification channels', 'integration',
      'Where alerts go: email, Slack, Telegram, Discord, Microsoft Teams and signed webhooks.'),
    behaviors: [
      'Channel types: email, Slack (incoming webhook), Telegram (bot token + chat), Discord, Microsoft Teams, generic webhook with HMAC signature',
      'Credentials stored encrypted; test message button',
      'Per-channel severity filter and quiet hours',
      'Delivery log with retries and the last error',
    ],
    acceptance: 'A test message to a Telegram channel with a wrong bot token fails with the provider error shown on the channel, and the token is never returned by the API after saving.',
  },
  {
    tool: whm('service-watchdog', 'whm-server-status', 'Service watchdog', 'service',
      'Checks every enabled service, restarts failed ones with backoff and raises an alert when restarts do not help.'),
    behaviors: [
      'Health probe per service beyond "unit active": TCP/HTTP/SMTP/IMAP/DNS probes',
      'Automatic restart with exponential backoff and a restart budget per hour',
      'Config test before restart; a failing test raises an alert instead of a restart loop',
      'Per-service enable/disable of auto-restart and probe interval',
      'Timeline of failures, restarts and recoveries',
    ],
    acceptance: 'Killing the dovecot process is detected by the IMAP probe, the service is restarted within one probe interval, and a third failure within the hour raises an alert instead of another restart.',
  },
  {
    tool: whm('error-reporting', 'whm-development', 'Error reporting (Sentry)', 'integration',
      'Opt-in reporting of the panel’s own errors to a Sentry-compatible DSN, with personal data scrubbed.'),
    behaviors: [
      'DSN, environment and sample rate; off by default',
      'Scrubs passwords, tokens, cookies, email addresses and IPs before sending',
      'Includes release, config generation and component (api, agent, web)',
      'Test event button',
    ],
    acceptance: 'With a DSN configured, a thrown API error is sent with its stack and release, and a request body containing a password field arrives with the value replaced by [redacted].',
  },
  {
    tool: whm('metrics-export', 'whm-development', 'Metrics endpoint', 'integration',
      'OpenMetrics/Prometheus endpoint for server, service and per-account metrics, protected by a scoped token.'),
    behaviors: [
      'Server CPU, memory, disk, load; service up/down; reconcile generation and drift',
      'Per-account slice usage and limits (CPU, memory, IO, processes), HTTP requests and bandwidth',
      'Scoped read-only token, optional IP allow list',
      'Cheap to scrape: values come from the agent’s existing samples, no extra collection',
    ],
    acceptance: 'A scrape with a valid metrics token returns OpenMetrics text including xpanel_account_memory_bytes for each account, and a scrape without the token is refused with 401.',
  },
  {
    tool: whm('api-explorer', 'whm-development', 'API & CLI', 'integration',
      'Browse the OpenAPI description, try calls with a scoped token, and copy the matching xpanel CLI command.'),
    behaviors: [
      'OpenAPI 3.1 reference generated from the same schemas the API validates with',
      'Try-it-out using the current session or a chosen token, with the response shown',
      'Equivalent xpanel CLI and curl command for every call',
      'Resellers and account owners see only operations their role allows',
    ],
    acceptance: 'Every operation in the explorer validates requests with the same schema the API uses, so an invalid body is rejected identically in the explorer and in the API.',
  },
  {
    tool: whm('config-as-code', 'whm-development', 'Configuration as code', 'state',
      'Export and import server, plans, resellers and accounts as reviewable files; apply with a diff and a dry run.'),
    behaviors: [
      'Export the desired-state tree (or a part of it) as YAML files without secrets',
      'Import shows a diff against the current state and a dry-run reconcile result',
      'Apply goes through the normal reconciler with config tests and rollback',
      'Every import is a single audited change',
    ],
    acceptance: 'Importing an exported tree into the same server produces an empty diff, and importing a plan with a changed disk limit shows exactly that change before applying.',
  },
  {
    tool: panel('git-deployments', 'files', 'Git deployments', 'deployment',
      'Push-to-deploy from GitHub, GitLab or any Git remote with build steps, atomic releases and one-click rollback.'),
    behaviors: [
      'Repository, branch and a per-site deploy key; webhook URL with secret for push events',
      'Build steps such as composer install, npm ci and npm run build, run as the account inside its slice with plan limits',
      'Atomic releases: each deploy goes into releases/<id>, shared files and folders are linked, then the current link switches',
      'Keep the last N releases; rollback switches back instantly',
      'Live build log; a failed build never touches the live release',
      'Hooks before and after switch (migrations, cache clear)',
    ],
    acceptance: 'A deploy whose build step exits non-zero leaves the current release unchanged and marks the deploy failed with its log, while a successful deploy switches the current link and keeps the previous release for rollback.',
  },
  {
    tool: panel('site-staging', 'domains', 'Staging sites', 'site',
      'Clone a site (files and databases) to a staging subdomain, test changes, then push selected parts back to live.'),
    behaviors: [
      'Create staging at staging.<domain> or a chosen subdomain, protected by a password',
      'Copies files and databases with renamed staging databases; search-replace of the domain in databases',
      'Push back files, databases or both with a pre-push backup of live',
      'Staging counts toward the account quota; delete removes its files and databases',
    ],
    acceptance: 'Pushing staging files to live first takes a backup of the live site, and restoring that backup returns live to its pre-push state.',
  },
  {
    tool: panel('account-containers', 'software', 'Containers', 'container',
      'Run containers rootless as the account inside its slice, with ports published only through the account’s domains.'),
    behaviors: [
      'Rootless containers (Podman) running as the account user; enabled per plan',
      'Image pull, run with environment variables and volumes inside the home',
      'Containers share the account slice, so plan CPU, memory, IO and process caps apply',
      'Expose a container port through a domain or subdomain via Nginx; no host ports are opened',
      'Logs, restart policy, stop, remove',
    ],
    acceptance: 'A container started by alice runs under alice’s UID inside xpanel-20014.slice, and a container memory spike is capped by the plan memory limit.',
  },
  {
    tool: whm('software-center', 'whm-software', 'Software center', 'components',
      'Install, upgrade and remove server components and runtimes from one place, with the memory and disk cost shown before installing.'),
    behaviors: [
      'Components: web engines (Nginx, Apache, OpenLiteSpeed), PHP versions and extensions, Node.js, Python, Ruby, Go and Java runtimes, MariaDB, Redis, Memcached, MongoDB, Elasticsearch/OpenSearch, RabbitMQ, ClamAV, ModSecurity + OWASP CRS, Pure-FTPd, Postfix/Dovecot, PowerDNS',
      'Installed / available versions side by side; default version per runtime',
      'Estimated idle memory and disk per component before install, and the live footprint after',
      'Install, upgrade and remove run as background jobs with logs; distro packages through apt or dnf, never curl-to-shell',
      'Pending OS updates with security updates highlighted; schedule unattended security updates',
      'Remove is refused while accounts still use the component, listing them',
    ],
    acceptance: 'Removing PHP 8.1 while two domains still use it is refused with both domains listed, and installing Redis shows its estimated idle memory before the install job starts.',
  },
  {
    tool: panel('app-installer', 'software', 'App installer', 'app-install',
      'One-click install of open-source apps (WordPress, Laravel, Joomla, Drupal, Ghost, Nextcloud…) with versions, updates, staging and clean removal.'),
    behaviors: [
      'Curated catalog with version, requirements (PHP/Node version, extensions, database) and licence',
      'Install into a domain or path: creates the database and user, writes config, sets permissions as the account',
      'Update policy per install: security only, minor, manual; pre-update backup and automatic rollback on failure',
      'Clone an install to a staging site and push back',
      'Installed apps list with version, update available and health',
      'Uninstall removes files, database and user after confirmation',
    ],
    acceptance: 'Installing WordPress into alice-shop.com/blog creates a database prefixed alice_, files owned by alice, and an entry in the installed list; uninstalling removes all three.',
  },
  {
    tool: panel('account-cache-services', 'software', 'Redis & Memcached', 'service',
      'Private Redis or Memcached for the account, running as the account user inside its slice on a socket in its home.'),
    behaviors: [
      'Enable Redis and/or Memcached per account when the plan allows',
      'Unix socket under the home (no TCP port), password for Redis, memory cap from the plan',
      'Eviction policy, persistence on/off (Redis), current memory and hit rate',
      'Flush, restart, disable',
      'Counts toward the account memory limit; never visible to other accounts',
    ],
    acceptance: 'alice’s Redis listens only on a socket inside /home/alice, runs as alice in xpanel-20014.slice, and nour cannot connect to it.',
  },
  {
    tool: whm('server-repair', 'whm-system-health', 'Repair center', 'repair',
      'Detects and fixes common server problems — broken packages, failed updates, full disks, broken services and permissions — each fix previewed, logged and verified.'),
    behaviors: [
      'Scan runs every detector and lists problems by severity with the evidence',
      'Package manager: interrupted dpkg (dpkg --configure -a), broken dependencies (apt-get -f install), held or locked package managers, corrupt rpm database (rpm --rebuilddb), dnf distro-sync, missing repository keys',
      'Updates: OS security and full updates, panel upgrade through the safe upgrade path, kernel update with a scheduled reboot window',
      'Disk: full or near-full filesystems and inode exhaustion with safe cleanups (rotated logs, package caches, old kernels, expired trash and backups)',
      'Services: unit failing to start → config test, restore the last good config generation, restart; missing or disabled required units',
      'System: time not synchronised, broken resolver, missing swap on low-memory hosts, missing cgroup controllers or disk quotas',
      'Panel self-repair: verify release files against their checksums and restore modified ones, rebuild the index database from the state files',
      'Each fix: dry-run preview of the exact commands and files, run as a job with live log, verification step, audit entry; destructive cleanups need confirmation',
      'Emergency CLI (xpanel repair) works without the web UI, e.g. after a firewall lockout',
    ],
    acceptance: 'With an interrupted dpkg run the scan reports "package configuration interrupted", the fix runs dpkg --configure -a as a job, and the follow-up check passes; the same scan on a healthy host reports no package problems.',
  },
  {
    tool: whm('account-repair', 'whm-account-functions', 'Account repair', 'account',
      'Fixes a broken account in one place: ownership and permissions, quota usage, web and PHP config, slice, mail and DNS.'),
    behaviors: [
      'Checks: home and file ownership/permissions, mailbox permissions, quota usage vs files, vhost and PHP-FPM pool present and valid, slice limits applied, DNS zone matches the state, SSL installed',
      'Fixes per check or "repair all", previewed first',
      'Re-render the account from its state files through the reconciler',
      'Recalculate disk usage and bandwidth counters',
      'Result report with before/after and audit entry',
    ],
    acceptance: 'After files in /home/alice are chowned to root, account repair reports wrong ownership and the fix restores alice ownership without changing file contents or modes outside the documented defaults.',
  },
  {
    tool: whm('notification-templates', 'whm-server-configuration', 'Notification templates', 'template',
      'Editable email and in-panel notification templates (account created, suspended, quota warnings, renewals) in English and Arabic.'),
    behaviors: [
      'Template per event with subject and body, variables listed and validated',
      'English and Arabic versions; missing translation blocks publishing',
      'Preview with sample data and test send',
      'Reseller-branded versions for reseller-owned accounts',
    ],
    acceptance: 'Saving a template that references an unknown variable is refused with the variable named, and the preview renders known variables with sample values.',
  },
  {
    tool: whm('audit-log', 'whm-server-status', 'Audit log', 'log-entry',
      'The server audit log: who did what, to which target, with filters and older pages.'),
    behaviors: [
      'Reads the append-only audit log for the root operator',
      'Filters by actor, action and target',
      'Pages older entries without dropping the newest page',
      'The page opens when the audit log can be read',
    ],
    acceptance: 'A readable audit log lists the stored rows, a filter keeps only the matching action, and the older-page link returns the next page of rows.',
  },
]

export const nativeTools: ToolDefinition[] = NATIVE.map(n => ({ ...n.tool, status: 'researched' }))

export const nativeSpecs: ToolSpec[] = NATIVE.map(n => ({
  id: n.tool.id,
  behaviors: n.behaviors,
  acceptance: n.acceptance,
  source: 'xpanel:native',
  upstreamFeatureKey: '',
  upstreamAcl: '',
  upstreamApi: '',
  absorbed: absorbedIntoNative[n.tool.id] ?? [],
}))
