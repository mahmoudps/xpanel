// Duplicate tools folded into native canonical tools during the navigation design (2026-10-22).
// Their behaviors still apply to the canonical tool.
import type { AbsorbedTool } from '../types.ts'

export const absorbedIntoNative: Readonly<Record<string, AbsorbedTool[]>> = {
  "database-insights": [
    {
      "id": "aapanel-db-table-tools",
      "name": "Table Maintenance Tools",
      "source": "https://www.aapanel.com/docs/Function/MySQL.html",
      "behaviors": [
        "Show engine, collation, row count and size",
        "Repair or optimize tables",
        "Convert tables between storage engines"
      ]
    }
  ],
  "intrusion-detection": [
    {
      "id": "brute-force-protection",
      "name": "Brute Force Protection",
      "source": "https://docs.cpanel.net/whm/security-center/cphulk-brute-force-protection/",
      "behaviors": [
        "Username protection (on): window 5 min (1-1440), 15 failures per account, local-only or local+remote origins, optional root lockout (off)",
        "IP protection (on): 5 failures per IP within the window, optional command and firewall block; one-day block after 30 failures (firewall block on)",
        "Failed-login retention 360 min; notifications for root login from unlisted IP, from known netblock, and brute-force detection",
        "Allow list and deny list: IPv4/IPv6/CIDR per line with comment, edit, delete selected/all, search, export; deny list never logs in",
        "Country rules (allow/deny/unspecified) from a GeoIP DB; reports of failed logins, blocked users, blocked IPs, one-day blocks with remove-block; clear history"
      ]
    },
    {
      "id": "aapanel-brute-force",
      "name": "Brute-Force Protection",
      "source": "https://www.aapanel.com/docs/Function/Security.html",
      "behaviors": [
        "Master switch",
        "Panel username lockout after repeated wrong credentials; unlock by timeout or CLI",
        "SSH IP ban after repeated failures; unlock by timeout or CLI",
        "Allow list never banned; block list denied on all ports",
        "History: failed logins over time, banned IPs with ban time and Unblock, plus remove all bans and clear reports"
      ]
    },
    {
      "id": "aapanel-fail2ban",
      "name": "Log-Based Intrusion Ban",
      "source": "https://www.aapanel.com/docs/Function/Plug-ins.html",
      "behaviors": [
        "Protection rules for websites and server services",
        "IP blacklist and whitelist",
        "Service status, and real-IP handling for CDN-fronted sites"
      ]
    },
    {
      "id": "aapanel-panel-login-protection",
      "name": "Panel Login Lockout",
      "source": "https://www.aapanel.com/docs/Function/Security.html",
      "behaviors": [
        "Failure threshold and lock time",
        "Unlock by waiting or CLI"
      ]
    }
  ],
  "trusted-proxies": [
    {
      "id": "aapanel-cdn-real-ip",
      "name": "CDN Real Visitor IP",
      "source": "https://www.aapanel.com/docs/Function/php.html",
      "behaviors": [
        "Header name and trusted source ranges",
        "Applied to logs and access rules"
      ]
    }
  ],
  "smtp-relay": [
    {
      "id": "aapanel-mail-smtp-relay",
      "name": "Outbound SMTP Relay",
      "source": "https://www.aapanel.com/docs/Function/Plug-ins.html",
      "behaviors": [
        "Relay host, port and credentials",
        "On/off toggle"
      ]
    }
  ],
  "mail-quality": [
    {
      "id": "aapanel-mail-dns-records",
      "name": "Mail DNS Records",
      "source": "https://www.aapanel.com/docs/Function/MailServer.html",
      "behaviors": [
        "Show the required records, each with its current status"
      ]
    },
    {
      "id": "whm-email-deliverability",
      "name": "Server-wide Email Deliverability",
      "source": "https://docs.cpanel.net/whm/email/email-deliverability-in-whm/",
      "behaviors": [
        "List every domain with a valid or problem status for each record type",
        "Show the record the server expects",
        "Repair one domain or many at once"
      ]
    }
  ],
  "mail-monitor": [
    {
      "id": "mail-statistics-summary",
      "name": "Mail Statistics Summary",
      "source": "https://docs.cpanel.net/whm/email/view-mail-statistics-summary/",
      "behaviors": [
        "Choose the period",
        "Show received, delivered and rejected totals",
        "Rank the top senders, recipients and hosts"
      ]
    }
  ],
  "database-tuning": [
    {
      "id": "db-server-config",
      "name": "Database Server Configuration",
      "source": "https://docs.cpanel.net/whm/sql-services/edit-sql-configuration/",
      "behaviors": [
        "Fields include buffer pool size/instances/chunk, log buffer and log file size, connection and packet limits, timeouts, buffers, logging, slow log, sql_mode (see notes for defaults and ranges)",
        "Units K/M/G/P/E accepted; bare numbers are bytes",
        "Suggestions computed from usage: review all or apply per field",
        "Per-field restore default and revert to previous",
        "Saving restarts the database service"
      ]
    }
  ]
}
