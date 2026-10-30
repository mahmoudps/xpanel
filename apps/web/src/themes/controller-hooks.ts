import type { ControllerDeclaration } from './controller-conformance.ts'

// Required controls and state-specific scopes are authored independently of rendered observations.
export const AUTHORITATIVE_CONTROLLER_DECLARATIONS: readonly ControllerDeclaration[] = [
  {
    "applicableRoutes": [
      "/files/backup"
    ],
    "id": "account-backup",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-account-backup-create]",
      "[data-account-backup-preview]",
      "[data-account-backup-refresh]",
      "[data-account-backup-restore]",
      "[data-account-backup-select]",
      "[data-account-backup-confirmation]",
      "[data-account-backup-ack]",
      "[data-account-backup-download]",
      "[data-account-backup-csv]",
      "[data-account-backup-status]",
      "[data-account-backup-archives]",
      "[data-account-backup-differences]",
      "[data-account-backup-diff-limit]"
    ],
    "rootSelector": "[data-account-backup]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-account-backup-create]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-account-backup-preview]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-account-backup-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-account-backup-restore]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-account-backup-select]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-account-backup-confirmation]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-account-backup-ack]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-account-backup-download]",
        "tags": [
          "a"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-account-backup-csv]",
        "tags": [
          "a"
        ],
        "occurrence": "first"
      },
      {
        "selector": "input,select,button",
        "tags": [
          "button",
          "input",
          "select"
        ],
        "occurrence": "every",
        "required": false
      }
    ],
    "conditionalRequirements": []
  },
  {
    "applicableRoutes": [
      "/databases/remote-access"
    ],
    "id": "account-database-remote",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-remote-cancel]",
      "[data-remote-comment]",
      "[data-remote-confirmation]",
      "[data-remote-count]",
      "[data-remote-host]",
      "[data-remote-refresh]",
      "[data-remote-remove]",
      "[data-remote-rows]",
      "[data-remote-save]",
      "[data-remote-scope]",
      "[data-remote-selected-panel]",
      "[data-remote-selected]",
      "[data-remote-status]"
    ],
    "rootSelector": "[data-account-database-remote]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-remote-cancel]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-remote-comment]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-remote-confirmation]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-remote-host]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-remote-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-remote-remove]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-remote-save]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/domains/dynamic-dns"
    ],
    "id": "account-dynamic-dns",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-ddns-cancel]",
      "[data-ddns-confirm-name]",
      "[data-ddns-confirm]",
      "[data-ddns-copy]",
      "[data-ddns-count]",
      "[data-ddns-create]",
      "[data-ddns-description]",
      "[data-ddns-endpoint]",
      "[data-ddns-hide]",
      "[data-ddns-hostname]",
      "[data-ddns-issued]",
      "[data-ddns-refresh]",
      "[data-ddns-rows]",
      "[data-ddns-secret]",
      "[data-ddns-selected]",
      "[data-ddns-status]",
      "[data-ddns-type]",
      "[data-ddns-username]",
      "[data-ddns-zone]",
      "[data-ddns-rotate]",
      "[data-ddns-delete]"
    ],
    "rootSelector": "[data-account-dynamic-dns]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-ddns-confirm-name]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-ddns-create]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-ddns-description]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-ddns-hostname]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-ddns-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-ddns-type]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-ddns-zone]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-ddns-rotate]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-ddns-delete]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "button,input,select",
        "tags": [
          "button",
          "input",
          "select"
        ],
        "occurrence": "every",
        "required": false
      }
    ]
  },
  {
    "applicableRoutes": [
      "/files/git"
    ],
    "id": "account-git",
    "nestedScopes": [],
    "optionalSelectors": [
      "[data-git-checkout]",
      "[data-git-clone]",
      "[data-git-init]",
      "[data-git-inspect]",
      "[data-git-pull]",
      "[data-git-refresh]",
      "[data-git-remove]"
    ],
    "requiredSelectors": [
      "[data-git-branch]",
      "[data-git-current]",
      "[data-git-history]",
      "[data-git-initial-branch]",
      "[data-git-origin]",
      "[data-git-path]",
      "[data-git-repository]",
      "[data-git-selected]",
      "[data-git-status]",
      "[data-git-tree]",
      "[data-git-url]"
    ],
    "rootSelector": "[data-account-git]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-git-branch]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-git-initial-branch]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-git-path]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-git-repository]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-git-url]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-git-checkout]",
        "tags": [
          "button"
        ],
        "occurrence": "first",
        "required": false
      },
      {
        "selector": "[data-git-clone]",
        "tags": [
          "button"
        ],
        "occurrence": "first",
        "required": false
      },
      {
        "selector": "[data-git-init]",
        "tags": [
          "button"
        ],
        "occurrence": "first",
        "required": false
      },
      {
        "selector": "[data-git-inspect]",
        "tags": [
          "button"
        ],
        "occurrence": "first",
        "required": false
      },
      {
        "selector": "[data-git-pull]",
        "tags": [
          "button"
        ],
        "occurrence": "first",
        "required": false
      },
      {
        "selector": "[data-git-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first",
        "required": false
      },
      {
        "selector": "[data-git-remove]",
        "tags": [
          "button"
        ],
        "occurrence": "first",
        "required": false
      },
      {
        "selector": "input,select",
        "tags": [
          "input",
          "select"
        ],
        "occurrence": "every",
        "required": false
      },
      {
        "selector": "button,input,select",
        "tags": [
          "button",
          "input",
          "select"
        ],
        "occurrence": "every",
        "required": false
      }
    ]
  },
  {
    "applicableRoutes": [
      "/software/htaccess"
    ],
    "id": "account-htaccess",
    "nestedScopes": [],
    "optionalSelectors": [
      "[data-htaccess-php-after-note]",
      "[data-htaccess-php-after]",
      "[data-htaccess-php-before-note]",
      "[data-htaccess-php-before]"
    ],
    "requiredSelectors": [
      "[data-htaccess-discard]",
      "[data-htaccess-insert]",
      "[data-htaccess-migrate]",
      "[data-htaccess-refresh]",
      "[data-htaccess-save]",
      "[data-htaccess-validate]",
      "[data-htaccess-domain]",
      "[data-htaccess-editor]",
      "[data-htaccess-status]",
      "[data-htaccess-versions]",
      "[data-htaccess-issues]"
    ],
    "rootSelector": "[data-htaccess-workspace]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-htaccess-discard]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-htaccess-insert]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-htaccess-migrate]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-htaccess-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-htaccess-save]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-htaccess-validate]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-htaccess-domain]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-htaccess-editor]",
        "tags": [
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "button,select",
        "tags": [
          "button",
          "select"
        ],
        "occurrence": "every",
        "required": false
      },
      {
        "selector": "[data-htaccess-preset]",
        "tags": [
          "select"
        ],
        "occurrence": "first",
        "required": false
      }
    ],
    "conditionalRequirements": []
  },
  {
    "applicableRoutes": [
      "/metrics/logs"
    ],
    "id": "account-logs",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-logs-class]",
      "[data-logs-domain]",
      "[data-logs-head]",
      "[data-logs-kind]",
      "[data-logs-level]",
      "[data-logs-read]",
      "[data-logs-rows]",
      "[data-logs-status]",
      "[data-logs-summary]",
      "[data-logs-text]"
    ],
    "rootSelector": "[data-account-logs]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-logs-class]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-logs-domain]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-logs-kind]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-logs-level]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-logs-read]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-logs-text]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "button,select,input",
        "tags": [
          "button",
          "input",
          "select"
        ],
        "occurrence": "every",
        "required": false
      }
    ]
  },
  {
    "applicableRoutes": [
      "/advanced/network-tools"
    ],
    "id": "account-network-tools",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-nettools-address]",
      "[data-nettools-at]",
      "[data-nettools-head]",
      "[data-nettools-host]",
      "[data-nettools-port]",
      "[data-nettools-rows]",
      "[data-nettools-run]",
      "[data-nettools-status]",
      "[data-nettools-summary]",
      "[data-nettools-target]",
      "[data-nettools-tool]",
      "[data-nettools-type]"
    ],
    "rootSelector": "[data-account-network-tools]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-nettools-host]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-nettools-port]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-nettools-run]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-nettools-tool]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-nettools-type]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "button,select,input",
        "tags": [
          "button",
          "input",
          "select"
        ],
        "occurrence": "every",
        "required": false
      }
    ]
  },
  {
    "applicableRoutes": [
      "/software/packages"
    ],
    "id": "account-packages",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-packages-available]",
      "[data-packages-capability]",
      "[data-packages-installed]",
      "[data-packages-inventory]",
      "[data-packages-recover]",
      "[data-packages-refresh]",
      "[data-packages-search]",
      "[data-packages-status]"
    ],
    "rootSelector": "[data-account-packages]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-packages-recover]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-packages-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-packages-search]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-package-op]",
        "tags": [
          "button"
        ],
        "occurrence": "every",
        "required": false
      },
      {
        "selector": "input,button",
        "tags": [
          "button",
          "input"
        ],
        "occurrence": "every",
        "required": false
      }
    ]
  },
  {
    "applicableRoutes": [
      "/email/spam-quarantine"
    ],
    "id": "account-quarantine",
    "nestedScopes": [],
    "optionalSelectors": [
      "[data-quarantine-from]",
      "[data-quarantine-held]",
      "[data-quarantine-observed]",
      "[data-quarantine-received]",
      "[data-quarantine-retention]",
      "[data-quarantine-score]",
      "[data-quarantine-subject]",
      "[data-quarantine-total]"
    ],
    "requiredSelectors": [
      "[data-quarantine-delete]",
      "[data-quarantine-expire]",
      "[data-quarantine-newest]",
      "[data-quarantine-older]",
      "[data-quarantine-refresh]",
      "[data-quarantine-release]",
      "[data-quarantine-mailbox]",
      "[data-quarantine-status]",
      "[data-quarantine-messages]",
      "[data-quarantine-detail]"
    ],
    "rootSelector": "[data-account-quarantine]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-quarantine-delete]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-quarantine-expire]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-quarantine-newest]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-quarantine-older]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-quarantine-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-quarantine-release]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-quarantine-mailbox]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "input,select,button",
        "tags": [
          "button",
          "input",
          "select"
        ],
        "occurrence": "every",
        "required": false
      }
    ],
    "conditionalRequirements": []
  },
  {
    "applicableRoutes": [
      "/domains/site-publisher"
    ],
    "id": "account-site-publisher",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-sitepub-created]",
      "[data-sitepub-domain]",
      "[data-sitepub-email]",
      "[data-sitepub-files]",
      "[data-sitepub-frame]",
      "[data-sitepub-lang]",
      "[data-sitepub-message]",
      "[data-sitepub-path]",
      "[data-sitepub-phone]",
      "[data-sitepub-preview-note]",
      "[data-sitepub-preview]",
      "[data-sitepub-publish]",
      "[data-sitepub-recovery]",
      "[data-sitepub-refresh]",
      "[data-sitepub-rollback]",
      "[data-sitepub-status]",
      "[data-sitepub-template]",
      "[data-sitepub-title]"
    ],
    "rootSelector": "[data-account-site-publisher]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-sitepub-domain]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-sitepub-email]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-sitepub-lang]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-sitepub-message]",
        "tags": [
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-sitepub-phone]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-sitepub-preview]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-sitepub-publish]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-sitepub-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-sitepub-rollback]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-sitepub-template]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-sitepub-title]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "button,input,select,textarea",
        "tags": [
          "button",
          "input",
          "select",
          "textarea"
        ],
        "occurrence": "every",
        "required": false
      }
    ]
  },
  {
    "applicableRoutes": [
      "/security/ssh"
    ],
    "id": "account-ssh",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-ssh-add]",
      "[data-ssh-file]",
      "[data-ssh-key]",
      "[data-ssh-login]",
      "[data-ssh-port]",
      "[data-ssh-refresh]",
      "[data-ssh-rows]",
      "[data-ssh-shell]",
      "[data-ssh-status]"
    ],
    "rootSelector": "[data-account-ssh]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-ssh-add]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-ssh-key]",
        "tags": [
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-ssh-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "button,textarea",
        "tags": [
          "button",
          "textarea"
        ],
        "occurrence": "every",
        "required": false
      }
    ]
  },
  {
    "applicableRoutes": [
      "/security/ssl"
    ],
    "id": "account-ssl",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-account-ssl-autossl-chip]",
      "[data-account-ssl-autossl]",
      "[data-account-ssl-bundle]",
      "[data-account-ssl-cert]",
      "[data-account-ssl-detail]",
      "[data-account-ssl-domain]",
      "[data-account-ssl-facts]",
      "[data-account-ssl-install]",
      "[data-account-ssl-key]",
      "[data-account-ssl-rows]",
      "[data-account-ssl-status]"
    ],
    "rootSelector": "[data-account-ssl]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-account-ssl-bundle]",
        "tags": [
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-account-ssl-cert]",
        "tags": [
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-account-ssl-domain]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-account-ssl-install]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-account-ssl-key]",
        "tags": [
          "textarea"
        ],
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/security/virus-scanner"
    ],
    "id": "account-virus-scan",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-vscan-engine]",
      "[data-vscan-next]",
      "[data-vscan-refresh]",
      "[data-vscan-rows]",
      "[data-vscan-signature-date]",
      "[data-vscan-signatures]",
      "[data-vscan-start]",
      "[data-vscan-status]",
      "[data-vscan-version]"
    ],
    "rootSelector": "[data-account-virus-scan]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-vscan-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-vscan-start]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "button",
        "tags": [
          "button"
        ],
        "occurrence": "every",
        "required": false
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/backups/restore-more"
    ],
    "id": "acct-restore",
    "nestedScopes": [],
    "optionalSelectors": [
      "[data-restore-more-archive]",
      "[data-restore-more-count-batch]",
      "[data-restore-more-count-failed]",
      "[data-restore-more-count-messages]",
      "[data-restore-more-count-pending]",
      "[data-restore-more-count-present]",
      "[data-restore-more-count-refused]",
      "[data-restore-more-count-remaining]",
      "[data-restore-more-count-restored]",
      "[data-restore-more-count-skipped]",
      "[data-restore-more-planned]",
      "[data-restore-more-quota]",
      "[data-restore-more-sha256]",
      "[data-restore-more-writer]"
    ],
    "requiredSelectors": [
      "[data-restore-more-account]",
      "[data-restore-more-ack]",
      "[data-restore-more-archives]",
      "[data-restore-more-components]",
      "[data-restore-more-continue]",
      "[data-restore-more-mailboxes]",
      "[data-restore-more-preview]",
      "[data-restore-more-restore]",
      "[data-restore-more-results]",
      "[data-restore-more-review]",
      "[data-restore-more-selection]",
      "[data-restore-more-status]",
      "[data-restore-more-steps]"
    ],
    "rootSelector": "[data-whm-restore-more-workspace]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-restore-more-account]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-restore-more-ack]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-restore-more-continue]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-restore-more-preview]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-restore-more-restore]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/domains/staging"
    ],
    "id": "acct-staging",
    "nestedScopes": [],
    "optionalSelectors": [
      "[data-staging-changes]",
      "[data-staging-domain]",
      "[data-staging-live]",
      "[data-staging-staging]"
    ],
    "requiredSelectors": [
      "[data-staging-ack]",
      "[data-staging-promote]",
      "[data-staging-refresh]",
      "[data-staging-results]",
      "[data-staging-review]",
      "[data-staging-rows]",
      "[data-staging-status]"
    ],
    "rootSelector": "[data-account-staging]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-staging-ack]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-staging-promote]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-staging-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/health"
    ],
    "id": "site-health",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-health-at]",
      "[data-health-count]",
      "[data-health-problems]",
      "[data-health-rows]",
      "[data-health-run]",
      "[data-health-status]"
    ],
    "rootSelector": "[data-site-health]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-health-run]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/advanced/cron"
    ],
    "id": "account-cron",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-cron-field=\"command\"]",
      "[data-cron-field=\"comment\"]",
      "[data-cron-field=\"day\"]",
      "[data-cron-field=\"hour\"]",
      "[data-cron-field=\"minute\"]",
      "[data-cron-field=\"month\"]",
      "[data-cron-field=\"runtime\"]",
      "[data-cron-field=\"weekday\"]",
      "[data-cron-new]",
      "[data-cron-observe]",
      "[data-cron-refresh]",
      "[data-cron-reset]",
      "[data-cron-run]",
      "[data-cron-save]",
      "[data-cron-preset]",
      "[data-cron-unlimited]",
      "[data-cron-enabled]",
      "[data-cron-status]",
      "[data-cron-jobs]"
    ],
    "rootSelector": "[data-account-cron]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-cron-field=\"command\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-field=\"comment\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-field=\"day\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-field=\"hour\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-field=\"minute\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-field=\"month\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-field=\"runtime\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-field=\"weekday\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-new]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-observe]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-reset]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-run]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-save]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-preset]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-unlimited]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-cron-enabled]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "input,select,textarea,button",
        "tags": [
          "button",
          "input",
          "select",
          "textarea"
        ],
        "occurrence": "every",
        "required": false
      }
    ],
    "conditionalRequirements": []
  },
  {
    "applicableRoutes": [
      "/databases/insights"
    ],
    "id": "account-database-insights",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-insights-database]",
      "[data-insights-databases]",
      "[data-insights-fact=\"at\"]",
      "[data-insights-fact=\"databases\"]",
      "[data-insights-fact=\"size\"]",
      "[data-insights-fact=\"tables\"]",
      "[data-insights-fact=\"users\"]",
      "[data-insights-read]",
      "[data-insights-status]",
      "[data-insights-tables]",
      "[data-insights-users]"
    ],
    "rootSelector": "[data-account-database-insights]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-insights-database]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-insights-read]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/email/encryption"
    ],
    "id": "account-pgp",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-pgp-address]",
      "[data-pgp-algorithm]",
      "[data-pgp-confirm]",
      "[data-pgp-days]",
      "[data-pgp-delete]",
      "[data-pgp-file]",
      "[data-pgp-generate]",
      "[data-pgp-import]",
      "[data-pgp-name]",
      "[data-pgp-passphrase]",
      "[data-pgp-refresh]",
      "[data-pgp-rows]",
      "[data-pgp-selected]",
      "[data-pgp-status]"
    ],
    "rootSelector": "[data-account-pgp]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-pgp-address]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-pgp-algorithm]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-pgp-confirm]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-pgp-days]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-pgp-delete]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-pgp-file]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-pgp-generate]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-pgp-import]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-pgp-name]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-pgp-passphrase]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-pgp-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-pgp-rows]",
        "tags": [
          "tbody",
          "tfoot",
          "thead"
        ],
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/email/spam-filters"
    ],
    "id": "account-spam",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-spam-allowlist]",
      "[data-spam-blocklist]",
      "[data-spam-score=\"spam-autodelete-score\"]",
      "[data-spam-score=\"spam-greylist\"]",
      "[data-spam-score=\"spam-header\"]",
      "[data-spam-score=\"spam-reject\"]",
      "[data-spam-score=\"spam-rewrite\"]",
      "[data-spam-save]",
      "[data-spam-enabled]",
      "[data-spam-box]",
      "[data-spam-autodelete]",
      "[data-spam-status]"
    ],
    "rootSelector": "[data-spam-settings]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-spam-allowlist]",
        "tags": [
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-spam-blocklist]",
        "tags": [
          "textarea"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-spam-score=\"spam-autodelete-score\"]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-spam-score=\"spam-greylist\"]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-spam-score=\"spam-header\"]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-spam-score=\"spam-reject\"]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-spam-score=\"spam-rewrite\"]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-spam-save]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-spam-enabled]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-spam-box]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-spam-autodelete]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "button,input,textarea",
        "tags": [
          "button",
          "input",
          "textarea"
        ],
        "occurrence": "every",
        "required": false
      }
    ],
    "conditionalRequirements": []
  },
  {
    "applicableRoutes": [
      "/software/apps",
      "/software/containers",
      "/software/cache"
    ],
    "id": "account-runtime",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-runtime-log]",
      "[data-runtime-refresh]",
      "[data-runtime-status]"
    ],
    "rootSelector": "[data-runtime-workspace]",
    "variants": [
      {
        "applicableRoutes": [
          "/software/apps"
        ],
        "optionalSelectors": [
          "[data-runtime-version=\"node\"]",
          "[data-runtime-version=\"python\"]",
          "[data-runtime-version=\"ruby\"]",
          "[data-runtime-deps]",
          "[data-runtime-preflight]",
          "[data-runtime-setup]"
        ],
        "requiredSelectors": [
          "[data-runtime-input=\"runtime\"]",
          "[data-runtime-input=\"name\"]",
          "[data-runtime-input=\"root\"]",
          "[data-runtime-input=\"startup\"]",
          "[data-runtime-input=\"domain\"]",
          "[data-runtime-input=\"path\"]",
          "[data-runtime-action=\"app-new\"]",
          "[data-runtime-action=\"app-save\"]",
          "[data-runtime-action=\"app-deps\"]",
          "[data-runtime-action=\"app-log\"]",
          "[data-runtime-action=\"deps-log\"]",
          "[data-runtime-action=\"env-add\"]",
          "[data-runtime-apps]",
          "[data-runtime-env]"
        ],
        "rootSelector": "[data-runtime-workspace=\"apps\"]",
        "id": "account-runtime:variants:0",
        "elements": [
          {
            "selector": "[data-runtime-input=\"runtime\"]",
            "tags": [
              "select"
            ],
            "occurrence": "every",
            "attributes": {}
          },
          {
            "selector": "[data-runtime-input=\"name\"]",
            "tags": [
              "input"
            ],
            "occurrence": "every",
            "attributes": {}
          },
          {
            "selector": "[data-runtime-input=\"root\"]",
            "tags": [
              "input"
            ],
            "occurrence": "every",
            "attributes": {}
          },
          {
            "selector": "[data-runtime-input=\"startup\"]",
            "tags": [
              "input"
            ],
            "occurrence": "every",
            "attributes": {}
          },
          {
            "selector": "[data-runtime-input=\"domain\"]",
            "tags": [
              "select"
            ],
            "occurrence": "every",
            "attributes": {}
          },
          {
            "selector": "[data-runtime-input=\"path\"]",
            "tags": [
              "input"
            ],
            "occurrence": "every",
            "attributes": {}
          },
          {
            "selector": "[data-runtime-action=\"app-new\"]",
            "tags": [
              "button"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "button"
            }
          },
          {
            "selector": "[data-runtime-action=\"app-save\"]",
            "tags": [
              "button"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "button"
            }
          },
          {
            "selector": "[data-runtime-action=\"app-deps\"]",
            "tags": [
              "button"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "button"
            }
          },
          {
            "selector": "[data-runtime-action=\"app-log\"]",
            "tags": [
              "button"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "button"
            }
          },
          {
            "selector": "[data-runtime-action=\"deps-log\"]",
            "tags": [
              "button"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "button"
            }
          },
          {
            "selector": "[data-runtime-action=\"env-add\"]",
            "tags": [
              "button"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "button"
            }
          },
          {
            "selector": "[data-runtime-tab]",
            "tags": [
              "button"
            ],
            "attributes": {
              "type": "button",
              "role": "tab"
            },
            "occurrence": "every",
            "required": false
          }
        ]
      },
      {
        "applicableRoutes": [
          "/software/containers"
        ],
        "optionalSelectors": [
          "[data-runtime-stat=\"engine\"]",
          "[data-runtime-stat=\"count\"]",
          "[data-runtime-stat=\"cleanup\"]",
          "[data-runtime-stat=\"memory\"]",
          "[data-runtime-stat=\"limits\"]"
        ],
        "requiredSelectors": [
          "[data-runtime-input=\"name\"]",
          "[data-runtime-input=\"image\"]",
          "[data-runtime-action=\"ctr-run\"]",
          "[data-runtime-action=\"ctr-prune\"]",
          "[data-runtime-action=\"env-add\"]",
          "[data-runtime-containers]",
          "[data-runtime-env]"
        ],
        "rootSelector": "[data-runtime-workspace=\"containers\"]",
        "id": "account-runtime:variants:1",
        "elements": [
          {
            "selector": "[data-runtime-input=\"name\"]",
            "tags": [
              "input"
            ],
            "occurrence": "every",
            "attributes": {}
          },
          {
            "selector": "[data-runtime-input=\"image\"]",
            "tags": [
              "input"
            ],
            "occurrence": "every",
            "attributes": {}
          },
          {
            "selector": "[data-runtime-action=\"ctr-run\"]",
            "tags": [
              "button"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "button"
            }
          },
          {
            "selector": "[data-runtime-action=\"ctr-prune\"]",
            "tags": [
              "button"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "button"
            }
          },
          {
            "selector": "[data-runtime-action=\"env-add\"]",
            "tags": [
              "button"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "button"
            }
          }
        ]
      },
      {
        "applicableRoutes": [
          "/software/cache"
        ],
        "optionalSelectors": [
          "[data-runtime-stat=\"redis\"]",
          "[data-runtime-stat=\"memcached\"]",
          "[data-runtime-stat=\"memory\"]",
          "[data-runtime-stat=\"cap\"]"
        ],
        "requiredSelectors": [
          "[data-runtime-input=\"service\"]",
          "[data-runtime-input=\"socket\"]",
          "[data-runtime-input=\"memory\"]",
          "[data-runtime-action=\"cache-save\"]",
          "[data-runtime-action=\"cache-flush\"]",
          "[data-runtime-cache]"
        ],
        "rootSelector": "[data-runtime-workspace=\"cache\"]",
        "id": "account-runtime:variants:2",
        "elements": [
          {
            "selector": "[data-runtime-input=\"service\"]",
            "tags": [
              "select"
            ],
            "occurrence": "every",
            "attributes": {}
          },
          {
            "selector": "[data-runtime-input=\"socket\"]",
            "tags": [
              "input"
            ],
            "occurrence": "every",
            "attributes": {
              "readonly": true,
              "dir": "ltr"
            }
          },
          {
            "selector": "[data-runtime-input=\"memory\"]",
            "tags": [
              "input"
            ],
            "occurrence": "every",
            "attributes": {
              "type": "number",
              "min": "8",
              "step": "1"
            }
          },
          {
            "selector": "[data-runtime-action=\"cache-save\"]",
            "tags": [
              "button"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "button"
            }
          },
          {
            "selector": "[data-runtime-action=\"cache-flush\"]",
            "tags": [
              "button"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "button"
            }
          }
        ]
      }
    ],
    "elements": [
      {
        "selector": "[data-runtime-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-runtime-input]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "every",
        "required": false
      },
      {
        "selector": "[data-runtime-row]",
        "tags": [
          "button"
        ],
        "attributes": {
          "type": "button"
        },
        "occurrence": "every",
        "required": false
      }
    ]
  },
  {
    "applicableRoutes": [
      "/advanced/error-pages",
      "/advanced/indexes",
      "/advanced/mime-types",
      "/security/hotlink",
      "/security/ip-blocker",
      "/domains/redirects"
    ],
    "id": "account-web-directives",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-wd-discard]",
      "[data-wd-domain]",
      "[data-wd-issues]",
      "[data-wd-notice]",
      "[data-wd-refresh]",
      "[data-wd-rows]",
      "[data-wd-save]",
      "[data-wd-status]"
    ],
    "rootSelector": "[data-web-directives]",
    "variants": [
      {
        "applicableRoutes": [
          "/advanced/error-pages"
        ],
        "requiredSelectors": [
          "[data-wd-add]",
          "[data-wd-clear]"
        ],
        "rootSelector": "[data-web-directives=\"error-pages\"]",
        "id": "account-web-directives:variants:0",
        "elements": [
          {
            "selector": "[data-wd-add]",
            "tags": [
              "button"
            ],
            "occurrence": "first"
          },
          {
            "selector": "[data-wd-clear]",
            "tags": [
              "button"
            ],
            "occurrence": "first"
          }
        ]
      },
      {
        "applicableRoutes": [
          "/advanced/mime-types"
        ],
        "requiredSelectors": [
          "[data-wd-add]",
          "[data-wd-clear]"
        ],
        "rootSelector": "[data-web-directives=\"mime-types\"]",
        "id": "account-web-directives:variants:1",
        "elements": [
          {
            "selector": "[data-wd-add]",
            "tags": [
              "button"
            ],
            "occurrence": "first"
          },
          {
            "selector": "[data-wd-clear]",
            "tags": [
              "button"
            ],
            "occurrence": "first"
          }
        ]
      },
      {
        "applicableRoutes": [
          "/security/ip-blocker"
        ],
        "requiredSelectors": [
          "[data-wd-add]",
          "[data-wd-clear]"
        ],
        "rootSelector": "[data-web-directives=\"ip-blocker\"]",
        "id": "account-web-directives:variants:2",
        "elements": [
          {
            "selector": "[data-wd-add]",
            "tags": [
              "button"
            ],
            "occurrence": "first"
          },
          {
            "selector": "[data-wd-clear]",
            "tags": [
              "button"
            ],
            "occurrence": "first"
          }
        ]
      },
      {
        "applicableRoutes": [
          "/domains/redirects"
        ],
        "requiredSelectors": [
          "[data-wd-add]",
          "[data-wd-clear]"
        ],
        "rootSelector": "[data-web-directives=\"redirects\"]",
        "id": "account-web-directives:variants:3",
        "elements": [
          {
            "selector": "[data-wd-add]",
            "tags": [
              "button"
            ],
            "occurrence": "first"
          },
          {
            "selector": "[data-wd-clear]",
            "tags": [
              "button"
            ],
            "occurrence": "first"
          }
        ]
      }
    ],
    "elements": [
      {
        "selector": "[data-wd-discard]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-wd-domain]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-wd-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-wd-save]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/email/filters"
    ],
    "id": "account-filters",
    "nestedScopes": [
      {
        "requiredSelectors": [
          "[data-condition-field=\"field\"]",
          "[data-condition-field=\"comparator\"]",
          "[data-condition-field=\"value\"]",
          "[data-condition-field=\"headerName\"]"
        ],
        "rootSelector": "[data-filter-condition]",
        "id": "account-filters:nestedScopes:0",
        "rootRequired": false,
        "elements": [
          {
            "selector": "[data-condition-field=\"field\"]",
            "tags": [
              "select"
            ],
            "occurrence": "first"
          },
          {
            "selector": "[data-condition-field=\"comparator\"]",
            "tags": [
              "select"
            ],
            "occurrence": "first"
          },
          {
            "selector": "[data-condition-field=\"value\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first"
          },
          {
            "selector": "[data-condition-field=\"headerName\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first"
          }
        ]
      },
      {
        "requiredSelectors": [
          "[data-action-field=\"type\"]",
          "[data-action-field=\"target\"]"
        ],
        "rootSelector": "[data-filter-action-row]",
        "id": "account-filters:nestedScopes:1",
        "rootRequired": false,
        "elements": [
          {
            "selector": "[data-action-field=\"type\"]",
            "tags": [
              "select"
            ],
            "occurrence": "first"
          },
          {
            "selector": "[data-action-field=\"target\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first"
          }
        ]
      },
      {
        "requiredSelectors": [
          "[name=\"from\"]",
          "[name=\"to\"]",
          "[name=\"subject\"]",
          "[name=\"body\"]"
        ],
        "rootSelector": "[data-filter-test]",
        "id": "account-filters:nestedScopes:2",
        "rootRequired": false,
        "elements": [
          {
            "selector": "[name=\"from\"]",
            "tags": [
              "input",
              "textarea"
            ],
            "occurrence": "first"
          },
          {
            "selector": "[name=\"to\"]",
            "tags": [
              "input",
              "textarea"
            ],
            "occurrence": "first"
          },
          {
            "selector": "[name=\"subject\"]",
            "tags": [
              "input",
              "textarea"
            ],
            "occurrence": "first"
          },
          {
            "selector": "[name=\"body\"]",
            "tags": [
              "input",
              "textarea"
            ],
            "occurrence": "first"
          }
        ]
      }
    ],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-filter-list]",
      "[data-filter-status]",
      "[data-filter-empty]",
      "[data-filter-count]",
      "[data-filter-compilation]",
      "[data-filter-preview]"
    ],
    "rootSelector": "[data-filter-workspace]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-filter-list]",
        "tags": [
          "ol"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-filter-scope]",
        "tags": [
          "select"
        ],
        "occurrence": "first",
        "required": false
      },
      {
        "selector": "[data-filter-editor]",
        "tags": [
          "form"
        ],
        "occurrence": "first",
        "required": false
      },
      {
        "selector": "[data-filter-trace]",
        "tags": [
          "ol"
        ],
        "occurrence": "first",
        "required": false
      },
      {
        "selector": "button",
        "tags": [
          "button"
        ],
        "occurrence": "every",
        "required": false
      },
      {
        "selector": "form input,form select,form textarea,[data-filter-test] input,[data-filter-test] textarea",
        "tags": [
          "input",
          "select",
          "textarea"
        ],
        "occurrence": "every",
        "required": false
      },
      {
        "selector": "[data-filter-action=\"up\"],[data-filter-action=\"down\"]",
        "tags": [
          "button"
        ],
        "occurrence": "every",
        "required": false
      }
    ],
    "conditionalRequirements": []
  },
  {
    "applicableRoutes": [
      "/whm/backups/destinations"
    ],
    "id": "acct-backup-runs",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-backup-retention-apply]",
      "[data-backup-retention-destination]",
      "[data-backup-retention-preview]",
      "[data-backup-retention-status]",
      "[data-backup-runs-empty=\"copies\"]",
      "[data-backup-runs-empty=\"recoveries\"]",
      "[data-backup-runs-empty=\"retention\"]",
      "[data-backup-runs-empty=\"runs\"]",
      "[data-backup-runs-fact=\"last\"]",
      "[data-backup-runs-fact=\"next\"]",
      "[data-backup-runs-fact=\"schedule\"]",
      "[data-backup-runs-loading]",
      "[data-backup-runs-read]",
      "[data-backup-runs-rows=\"copies\"]",
      "[data-backup-runs-rows=\"recoveries\"]",
      "[data-backup-runs-rows=\"retention\"]",
      "[data-backup-runs-rows=\"runs\"]",
      "[data-backup-runs-start]",
      "[data-backup-runs-status]"
    ],
    "rootSelector": "[data-whm-backup-runs]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-backup-retention-apply]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-retention-destination]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-retention-preview]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-runs-read]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-runs-start]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-recover]",
        "tags": [
          "button"
        ],
        "occurrence": "every",
        "required": false
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/transfers/convert-addon"
    ],
    "id": "acct-convert-addon",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-acct-convert-apply]",
      "[data-acct-convert-capability]",
      "[data-acct-convert-empty]",
      "[data-acct-convert-facts]",
      "[data-acct-convert-form]",
      "[data-acct-convert-input=\"confirm\"]",
      "[data-acct-convert-input=\"domainId\"]",
      "[data-acct-convert-input=\"planId\"]",
      "[data-acct-convert-input=\"username\"]",
      "[data-acct-convert-loading]",
      "[data-acct-convert-preview]",
      "[data-acct-convert-refresh]",
      "[data-acct-convert-review-status]",
      "[data-acct-convert-rows=\"conflicts\"]",
      "[data-acct-convert-rows=\"dns\"]",
      "[data-acct-convert-rows=\"domains\"]",
      "[data-acct-convert-rows=\"mail\"]",
      "[data-acct-convert-status]"
    ],
    "rootSelector": "[data-acct-convert-addon]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-acct-convert-apply]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-convert-input=\"confirm\"]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-convert-input=\"domainId\"]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-convert-input=\"planId\"]",
        "tags": [
          "select"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-convert-input=\"username\"]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-convert-preview]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-convert-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/plans/enhancements"
    ],
    "id": "acct-enhancements",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-acct-enh-empty]",
      "[data-acct-enh-form=\"assignment\"]",
      "[data-acct-enh-form=\"definition\"]",
      "[data-acct-enh-form=\"limit\"]",
      "[data-acct-enh-input=\"assign-enhancement\"]",
      "[data-acct-enh-input=\"assign-scope\"]",
      "[data-acct-enh-input=\"assign-target\"]",
      "[data-acct-enh-input=\"assign-value\"]",
      "[data-acct-enh-input=\"id\"]",
      "[data-acct-enh-input=\"kind\"]",
      "[data-acct-enh-input=\"label\"]",
      "[data-acct-enh-input=\"limit-enhancement\"]",
      "[data-acct-enh-input=\"limit-reseller\"]",
      "[data-acct-enh-input=\"limit-value\"]",
      "[data-acct-enh-input=\"max\"]",
      "[data-acct-enh-input=\"min\"]",
      "[data-acct-enh-loading]",
      "[data-acct-enh-refresh]",
      "[data-acct-enh-rows=\"assignments\"]",
      "[data-acct-enh-rows=\"definitions\"]",
      "[data-acct-enh-rows=\"limits\"]",
      "[data-acct-enh-save-status]",
      "[data-acct-enh-status]",
      "[data-acct-enh-value-field]"
    ],
    "rootSelector": "[data-acct-enh-workspace]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-acct-enh-form=\"assignment\"]",
        "tags": [
          "form"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-enh-form=\"definition\"]",
        "tags": [
          "form"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-enh-form=\"limit\"]",
        "tags": [
          "form"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-enh-input=\"assign-enhancement\"]",
        "tags": [
          "input",
          "select"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-enh-input=\"assign-scope\"]",
        "tags": [
          "input",
          "select"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-enh-input=\"assign-target\"]",
        "tags": [
          "input",
          "select"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-enh-input=\"assign-value\"]",
        "tags": [
          "input",
          "select"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-enh-input=\"id\"]",
        "tags": [
          "input",
          "select"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-enh-input=\"kind\"]",
        "tags": [
          "input",
          "select"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-enh-input=\"label\"]",
        "tags": [
          "input",
          "select"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-enh-input=\"limit-enhancement\"]",
        "tags": [
          "input",
          "select"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-enh-input=\"limit-reseller\"]",
        "tags": [
          "input",
          "select"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-enh-input=\"limit-value\"]",
        "tags": [
          "input",
          "select"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-enh-input=\"max\"]",
        "tags": [
          "input",
          "select"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-enh-input=\"min\"]",
        "tags": [
          "input",
          "select"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-enh-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-enh-submit], [data-acct-enh-rows] button",
        "tags": [
          "button"
        ],
        "occurrence": "every",
        "required": false
      }
    ]
  },
  {
    "applicableRoutes": [
      "/preferences/team"
    ],
    "id": "acct-team",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-acct-team-cancel]",
      "[data-acct-team-domain]",
      "[data-acct-team-editor-heading]",
      "[data-acct-team-empty]",
      "[data-acct-team-form]",
      "[data-acct-team-input=\"contactEmail\"]",
      "[data-acct-team-input=\"expiresAt\"]",
      "[data-acct-team-input=\"expiryReason\"]",
      "[data-acct-team-input=\"notes\"]",
      "[data-acct-team-input=\"username\"]",
      "[data-acct-team-link-copy]",
      "[data-acct-team-link-done]",
      "[data-acct-team-link-expires]",
      "[data-acct-team-link-heading]",
      "[data-acct-team-link-status]",
      "[data-acct-team-link-url]",
      "[data-acct-team-link]",
      "[data-acct-team-list-status]",
      "[data-acct-team-loading]",
      "[data-acct-team-refresh]",
      "[data-acct-team-rows]",
      "[data-acct-team-save-status]",
      "[data-acct-team-save]",
      "[data-acct-team-signin-state]",
      "[data-acct-team-signin]",
      "[data-acct-team-status]",
      "[data-acct-team-usage]",
      "[data-acct-team-role]"
    ],
    "rootSelector": "[data-acct-team-workspace]",
    "variants": [
      {
        "id": "acct-team-role-count",
        "rootSelector": "[data-acct-team-workspace]",
        "rootRequired": true,
        "scopeSelector": "[data-acct-team-role]",
        "scopeCount": 4
      }
    ],
    "elements": [
      {
        "selector": "[data-acct-team-cancel]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-team-form]",
        "tags": [
          "form"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-team-input=\"contactEmail\"]",
        "tags": [
          "input"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-team-input=\"expiresAt\"]",
        "tags": [
          "input"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-team-input=\"expiryReason\"]",
        "tags": [
          "input"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-team-input=\"notes\"]",
        "tags": [
          "input"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-team-input=\"username\"]",
        "tags": [
          "input"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-team-link-copy]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-team-link-done]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-team-link-url]",
        "tags": [
          "input"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-team-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-team-save]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-team-role]",
        "tags": [
          "input"
        ],
        "occurrence": "every"
      }
    ],
    "conditionalRequirements": []
  },
  {
    "applicableRoutes": [
      "/whm/accounts/templates"
    ],
    "id": "acct-templates",
    "nestedScopes": [],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-acct-templates-cancel]",
      "[data-acct-templates-editor-heading]",
      "[data-acct-templates-empty]",
      "[data-acct-templates-form]",
      "[data-acct-templates-input=\"defaultPage.body\"]",
      "[data-acct-templates-input=\"defaultPage.title\"]",
      "[data-acct-templates-input=\"name\"]",
      "[data-acct-templates-input=\"suspendedPage.body\"]",
      "[data-acct-templates-input=\"suspendedPage.title\"]",
      "[data-acct-templates-input=\"zone\"]",
      "[data-acct-templates-list-status]",
      "[data-acct-templates-loading]",
      "[data-acct-templates-plans]",
      "[data-acct-templates-preview]",
      "[data-acct-templates-refresh]",
      "[data-acct-templates-rows]",
      "[data-acct-templates-save-status]",
      "[data-acct-templates-save]",
      "[data-acct-templates-status]"
    ],
    "rootSelector": "[data-acct-templates-workspace]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-acct-templates-cancel]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-templates-form]",
        "tags": [
          "form"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-templates-input=\"defaultPage.body\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-templates-input=\"defaultPage.title\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-templates-input=\"name\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-templates-input=\"suspendedPage.body\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-templates-input=\"suspendedPage.title\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-templates-input=\"zone\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "occurrence": "every"
      },
      {
        "selector": "[data-acct-templates-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-acct-templates-save]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/databases/mariadb"
    ],
    "id": "database-workspace",
    "nestedScopes": [
      {
        "requiredSelectors": [
          "[name=\"userId\"]",
          "[name=\"databaseId\"]"
        ],
        "rootSelector": "[data-db-grant-form]",
        "id": "database-workspace:nestedScopes:0",
        "rootRequired": false,
        "elements": [
          {
            "selector": "[name=\"userId\"]",
            "tags": [
              "select"
            ],
            "occurrence": "first"
          },
          {
            "selector": "[name=\"databaseId\"]",
            "tags": [
              "select"
            ],
            "occurrence": "first"
          }
        ]
      }
    ],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-db-clear]",
      "[data-db-create-submit]",
      "[data-db-grant-advanced-toggle]",
      "[data-db-grant-current]",
      "[data-db-grant-discard]",
      "[data-db-grant-preview]",
      "[data-db-grant-save]",
      "[data-db-refresh]",
      "[data-db-reload]",
      "[data-dbu-clear]",
      "[data-dbu-create-submit]",
      "[data-dbu-generate]",
      "[data-dbu-reveal]",
      "[data-db-create]",
      "[data-dbu-create]",
      "[data-db-grant-form]",
      "[data-db-status]"
    ],
    "rootSelector": "[data-database-workspace]",
    "variants": [],
    "elements": [
      {
        "selector": "[data-db-clear]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-db-create-submit]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-db-grant-advanced-toggle]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-db-grant-discard]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-db-grant-save]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-db-refresh]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-db-reload]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-dbu-clear]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-dbu-create-submit]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-dbu-generate]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-dbu-reveal]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-db-create]",
        "tags": [
          "form"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-dbu-create]",
        "tags": [
          "form"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-db-grant-form]",
        "tags": [
          "form"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-db-edit-grants],[data-db-trash-action],[data-db-restore-action]",
        "tags": [
          "button"
        ],
        "occurrence": "every",
        "required": false
      }
    ],
    "conditionalRequirements": []
  },
  {
    "applicableRoutes": [
      "/databases/phpmyadmin",
      "/databases/postgresql",
      "/databases/phppgadmin",
      "/whm/databases/phpmyadmin",
      "/whm/databases/upgrade",
      "/whm/databases/redis",
      "/whm/databases/mongodb"
    ],
    "id": "db-engines",
    "nestedScopes": [],
    "optionalSelectors": [
      "#db-pg-owner",
      "#db-pg-password-user",
      "[data-db-fact=\"active\"]",
      "[data-db-fact=\"configPath\"]",
      "[data-db-fact=\"configState\"]",
      "[data-db-fact=\"databases\"]",
      "[data-db-fact=\"enabled\"]",
      "[data-db-fact=\"family\"]",
      "[data-db-fact=\"installed\"]",
      "[data-db-fact=\"limit\"]",
      "[data-db-fact=\"observedAt\"]",
      "[data-db-fact=\"package\"]",
      "[data-db-fact=\"phppgadmin\"]",
      "[data-db-fact=\"postgresql\"]",
      "[data-db-fact=\"running\"]",
      "[data-db-fact=\"session\"]",
      "[data-db-fact=\"signon\"]",
      "[data-db-fact=\"state\"]",
      "[data-db-fact=\"ticket\"]",
      "[data-db-fact=\"unit\"]",
      "[data-db-fact=\"version\"]",
      "[data-db-rows=\"databases\"]",
      "[data-db-rows=\"packages\"]",
      "[data-db-rows=\"roles\"]"
    ],
    "requiredSelectors": [
      "[data-db-status]",
      "[data-db-action=\"refresh\"]"
    ],
    "rootSelector": "[data-db-engine]",
    "variants": [
      {
        "applicableRoutes": [
          "/databases/phpmyadmin"
        ],
        "optionalSelectors": [
          "#db-pg-owner",
          "#db-pg-password-user",
          "[data-db-fact=\"active\"]",
          "[data-db-fact=\"configPath\"]",
          "[data-db-fact=\"configState\"]",
          "[data-db-fact=\"databases\"]",
          "[data-db-fact=\"enabled\"]",
          "[data-db-fact=\"family\"]",
          "[data-db-fact=\"installed\"]",
          "[data-db-fact=\"limit\"]",
          "[data-db-fact=\"observedAt\"]",
          "[data-db-fact=\"package\"]",
          "[data-db-fact=\"phppgadmin\"]",
          "[data-db-fact=\"postgresql\"]",
          "[data-db-fact=\"running\"]",
          "[data-db-fact=\"session\"]",
          "[data-db-fact=\"signon\"]",
          "[data-db-fact=\"state\"]",
          "[data-db-fact=\"ticket\"]",
          "[data-db-fact=\"unit\"]",
          "[data-db-fact=\"version\"]",
          "[data-db-rows=\"databases\"]",
          "[data-db-rows=\"packages\"]",
          "[data-db-rows=\"roles\"]"
        ],
        "rootSelector": "[data-db-engine=\"account-phpmyadmin\"]",
        "id": "db-engines:variants:0",
        "elements": [
          {
            "selector": "#db-pg-owner",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          },
          {
            "selector": "#db-pg-password-user",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          },
          {
            "selector": "[data-db-action=\"open\"]",
            "tags": [
              "button"
            ],
            "attributes": {
              "type": "button"
            },
            "occurrence": "first"
          }
        ],
        "requiredSelectors": [
          "[data-db-action=\"open\"]"
        ]
      },
      {
        "applicableRoutes": [
          "/databases/postgresql"
        ],
        "optionalSelectors": [
          "#db-pg-owner",
          "#db-pg-password-user",
          "[data-db-fact=\"active\"]",
          "[data-db-fact=\"configPath\"]",
          "[data-db-fact=\"configState\"]",
          "[data-db-fact=\"databases\"]",
          "[data-db-fact=\"enabled\"]",
          "[data-db-fact=\"family\"]",
          "[data-db-fact=\"installed\"]",
          "[data-db-fact=\"limit\"]",
          "[data-db-fact=\"observedAt\"]",
          "[data-db-fact=\"package\"]",
          "[data-db-fact=\"phppgadmin\"]",
          "[data-db-fact=\"postgresql\"]",
          "[data-db-fact=\"running\"]",
          "[data-db-fact=\"session\"]",
          "[data-db-fact=\"signon\"]",
          "[data-db-fact=\"state\"]",
          "[data-db-fact=\"ticket\"]",
          "[data-db-fact=\"unit\"]",
          "[data-db-fact=\"version\"]",
          "[data-db-rows=\"databases\"]",
          "[data-db-rows=\"packages\"]",
          "[data-db-rows=\"roles\"]"
        ],
        "rootSelector": "[data-db-engine=\"account-postgresql\"]",
        "id": "db-engines:variants:1",
        "elements": [
          {
            "selector": "#db-pg-owner",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          },
          {
            "selector": "#db-pg-password-user",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          }
        ],
        "conditionalRequired": [
          {
            "id": "form[data-db-pg-form=\"database\"]:managed",
            "rootAttributes": {
              "data-db-can-manage": "true"
            },
            "rootSelector": "form[data-db-pg-form=\"database\"]",
            "rootRequired": true,
            "semanticTag": "form",
            "requiredSelectors": [
              "[name=\"name\"]",
              "[name=\"owner\"]",
              "button[type=\"submit\"]"
            ],
            "elements": [
              {
                "selector": "[name=\"name\"]",
                "tags": [
                  "input"
                ],
                "attributes": {},
                "occurrence": "first"
              },
              {
                "selector": "[name=\"owner\"]",
                "tags": [
                  "select"
                ],
                "attributes": {},
                "occurrence": "first"
              },
              {
                "selector": "button[type=\"submit\"]",
                "tags": [
                  "button"
                ],
                "attributes": {
                  "type": "submit"
                },
                "occurrence": "first"
              }
            ]
          },
          {
            "id": "[data-db-pg-form=\"database\"]:inert",
            "rootAttributes": {
              "data-db-can-manage": "false"
            },
            "rootSelector": "[data-db-pg-form=\"database\"]",
            "rootRequired": true,
            "semanticTag": "div",
            "requiredSelectors": [
              "[name=\"name\"]",
              "[name=\"owner\"]",
              "button[type=\"submit\"]"
            ],
            "elements": [
              {
                "selector": "[name=\"name\"]",
                "tags": [
                  "input"
                ],
                "attributes": {
                  "disabled": true
                },
                "occurrence": "first"
              },
              {
                "selector": "[name=\"owner\"]",
                "tags": [
                  "select"
                ],
                "attributes": {
                  "disabled": true
                },
                "occurrence": "first"
              },
              {
                "selector": "button[type=\"submit\"]",
                "tags": [
                  "button"
                ],
                "attributes": {
                  "type": "submit",
                  "disabled": true
                },
                "occurrence": "first"
              }
            ]
          },
          {
            "id": "form[data-db-pg-form=\"user\"]:managed",
            "rootAttributes": {
              "data-db-can-manage": "true"
            },
            "rootSelector": "form[data-db-pg-form=\"user\"]",
            "rootRequired": true,
            "semanticTag": "form",
            "requiredSelectors": [
              "[name=\"name\"]",
              "[name=\"password\"]",
              "button[type=\"submit\"]"
            ],
            "elements": [
              {
                "selector": "[name=\"name\"]",
                "tags": [
                  "input"
                ],
                "attributes": {},
                "occurrence": "first"
              },
              {
                "selector": "[name=\"password\"]",
                "tags": [
                  "input"
                ],
                "attributes": {
                  "type": "password"
                },
                "occurrence": "first"
              },
              {
                "selector": "button[type=\"submit\"]",
                "tags": [
                  "button"
                ],
                "attributes": {
                  "type": "submit"
                },
                "occurrence": "first"
              }
            ]
          },
          {
            "id": "[data-db-pg-form=\"user\"]:inert",
            "rootAttributes": {
              "data-db-can-manage": "false"
            },
            "rootSelector": "[data-db-pg-form=\"user\"]",
            "rootRequired": true,
            "semanticTag": "div",
            "requiredSelectors": [
              "[name=\"name\"]",
              "[name=\"password\"]",
              "button[type=\"submit\"]"
            ],
            "elements": [
              {
                "selector": "[name=\"name\"]",
                "tags": [
                  "input"
                ],
                "attributes": {
                  "disabled": true
                },
                "occurrence": "first"
              },
              {
                "selector": "[name=\"password\"]",
                "tags": [
                  "input"
                ],
                "attributes": {
                  "type": "password",
                  "disabled": true
                },
                "occurrence": "first"
              },
              {
                "selector": "button[type=\"submit\"]",
                "tags": [
                  "button"
                ],
                "attributes": {
                  "type": "submit",
                  "disabled": true
                },
                "occurrence": "first"
              }
            ]
          },
          {
            "id": "form[data-db-pg-form=\"password\"]:managed",
            "rootAttributes": {
              "data-db-can-manage": "true"
            },
            "rootSelector": "form[data-db-pg-form=\"password\"]",
            "rootRequired": true,
            "semanticTag": "form",
            "requiredSelectors": [
              "[name=\"user\"]",
              "[name=\"password\"]",
              "button[type=\"submit\"]"
            ],
            "elements": [
              {
                "selector": "[name=\"user\"]",
                "tags": [
                  "select"
                ],
                "attributes": {},
                "occurrence": "first"
              },
              {
                "selector": "[name=\"password\"]",
                "tags": [
                  "input"
                ],
                "attributes": {
                  "type": "password"
                },
                "occurrence": "first"
              },
              {
                "selector": "button[type=\"submit\"]",
                "tags": [
                  "button"
                ],
                "attributes": {
                  "type": "submit"
                },
                "occurrence": "first"
              }
            ]
          },
          {
            "id": "[data-db-pg-form=\"password\"]:inert",
            "rootAttributes": {
              "data-db-can-manage": "false"
            },
            "rootSelector": "[data-db-pg-form=\"password\"]",
            "rootRequired": true,
            "semanticTag": "div",
            "requiredSelectors": [
              "[name=\"user\"]",
              "[name=\"password\"]",
              "button[type=\"submit\"]"
            ],
            "elements": [
              {
                "selector": "[name=\"user\"]",
                "tags": [
                  "select"
                ],
                "attributes": {
                  "disabled": true
                },
                "occurrence": "first"
              },
              {
                "selector": "[name=\"password\"]",
                "tags": [
                  "input"
                ],
                "attributes": {
                  "type": "password",
                  "disabled": true
                },
                "occurrence": "first"
              },
              {
                "selector": "button[type=\"submit\"]",
                "tags": [
                  "button"
                ],
                "attributes": {
                  "type": "submit",
                  "disabled": true
                },
                "occurrence": "first"
              }
            ]
          }
        ]
      },
      {
        "applicableRoutes": [
          "/databases/phppgadmin"
        ],
        "optionalSelectors": [
          "#db-pg-owner",
          "#db-pg-password-user",
          "[data-db-fact=\"active\"]",
          "[data-db-fact=\"configPath\"]",
          "[data-db-fact=\"configState\"]",
          "[data-db-fact=\"databases\"]",
          "[data-db-fact=\"enabled\"]",
          "[data-db-fact=\"family\"]",
          "[data-db-fact=\"installed\"]",
          "[data-db-fact=\"limit\"]",
          "[data-db-fact=\"observedAt\"]",
          "[data-db-fact=\"package\"]",
          "[data-db-fact=\"phppgadmin\"]",
          "[data-db-fact=\"postgresql\"]",
          "[data-db-fact=\"running\"]",
          "[data-db-fact=\"session\"]",
          "[data-db-fact=\"signon\"]",
          "[data-db-fact=\"state\"]",
          "[data-db-fact=\"ticket\"]",
          "[data-db-fact=\"unit\"]",
          "[data-db-fact=\"version\"]",
          "[data-db-rows=\"databases\"]",
          "[data-db-rows=\"packages\"]",
          "[data-db-rows=\"roles\"]"
        ],
        "rootSelector": "[data-db-engine=\"account-phppgadmin\"]",
        "id": "db-engines:variants:2",
        "elements": [
          {
            "selector": "#db-pg-owner",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          },
          {
            "selector": "#db-pg-password-user",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          }
        ]
      },
      {
        "applicableRoutes": [
          "/whm/databases/phpmyadmin"
        ],
        "optionalSelectors": [
          "#db-pg-owner",
          "#db-pg-password-user",
          "[data-db-fact=\"active\"]",
          "[data-db-fact=\"configPath\"]",
          "[data-db-fact=\"configState\"]",
          "[data-db-fact=\"databases\"]",
          "[data-db-fact=\"enabled\"]",
          "[data-db-fact=\"family\"]",
          "[data-db-fact=\"installed\"]",
          "[data-db-fact=\"limit\"]",
          "[data-db-fact=\"observedAt\"]",
          "[data-db-fact=\"package\"]",
          "[data-db-fact=\"phppgadmin\"]",
          "[data-db-fact=\"postgresql\"]",
          "[data-db-fact=\"running\"]",
          "[data-db-fact=\"session\"]",
          "[data-db-fact=\"signon\"]",
          "[data-db-fact=\"state\"]",
          "[data-db-fact=\"ticket\"]",
          "[data-db-fact=\"unit\"]",
          "[data-db-fact=\"version\"]",
          "[data-db-rows=\"databases\"]",
          "[data-db-rows=\"packages\"]",
          "[data-db-rows=\"roles\"]"
        ],
        "rootSelector": "[data-db-engine=\"whm-phpmyadmin\"]",
        "id": "db-engines:variants:3",
        "elements": [
          {
            "selector": "#db-pg-owner",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          },
          {
            "selector": "#db-pg-password-user",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          },
          {
            "selector": "[data-db-action=\"open\"]",
            "tags": [
              "button"
            ],
            "attributes": {
              "type": "button"
            },
            "occurrence": "first"
          }
        ],
        "requiredSelectors": [
          "[data-db-action=\"open\"]"
        ]
      },
      {
        "applicableRoutes": [
          "/whm/databases/upgrade"
        ],
        "optionalSelectors": [
          "#db-pg-owner",
          "#db-pg-password-user",
          "[data-db-fact=\"active\"]",
          "[data-db-fact=\"configPath\"]",
          "[data-db-fact=\"configState\"]",
          "[data-db-fact=\"databases\"]",
          "[data-db-fact=\"enabled\"]",
          "[data-db-fact=\"family\"]",
          "[data-db-fact=\"installed\"]",
          "[data-db-fact=\"limit\"]",
          "[data-db-fact=\"observedAt\"]",
          "[data-db-fact=\"package\"]",
          "[data-db-fact=\"phppgadmin\"]",
          "[data-db-fact=\"postgresql\"]",
          "[data-db-fact=\"running\"]",
          "[data-db-fact=\"session\"]",
          "[data-db-fact=\"signon\"]",
          "[data-db-fact=\"state\"]",
          "[data-db-fact=\"ticket\"]",
          "[data-db-fact=\"unit\"]",
          "[data-db-fact=\"version\"]",
          "[data-db-rows=\"databases\"]",
          "[data-db-rows=\"packages\"]",
          "[data-db-rows=\"roles\"]"
        ],
        "rootSelector": "[data-db-engine=\"whm-upgrade\"]",
        "id": "db-engines:variants:4",
        "elements": [
          {
            "selector": "#db-pg-owner",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          },
          {
            "selector": "#db-pg-password-user",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          },
          {
            "selector": "[data-db-action=\"upgrade\"]",
            "tags": [
              "button"
            ],
            "attributes": {
              "type": "button"
            },
            "occurrence": "first"
          }
        ],
        "requiredSelectors": [
          "[data-db-action=\"upgrade\"]"
        ]
      },
      {
        "applicableRoutes": [
          "/whm/databases/redis"
        ],
        "optionalSelectors": [
          "#db-pg-owner",
          "#db-pg-password-user",
          "[data-db-fact=\"active\"]",
          "[data-db-fact=\"configPath\"]",
          "[data-db-fact=\"configState\"]",
          "[data-db-fact=\"databases\"]",
          "[data-db-fact=\"enabled\"]",
          "[data-db-fact=\"family\"]",
          "[data-db-fact=\"installed\"]",
          "[data-db-fact=\"limit\"]",
          "[data-db-fact=\"observedAt\"]",
          "[data-db-fact=\"package\"]",
          "[data-db-fact=\"phppgadmin\"]",
          "[data-db-fact=\"postgresql\"]",
          "[data-db-fact=\"running\"]",
          "[data-db-fact=\"session\"]",
          "[data-db-fact=\"signon\"]",
          "[data-db-fact=\"state\"]",
          "[data-db-fact=\"ticket\"]",
          "[data-db-fact=\"unit\"]",
          "[data-db-fact=\"version\"]",
          "[data-db-rows=\"databases\"]",
          "[data-db-rows=\"packages\"]",
          "[data-db-rows=\"roles\"]"
        ],
        "rootSelector": "[data-db-engine=\"whm-redis\"]",
        "id": "db-engines:variants:5",
        "elements": [
          {
            "selector": "#db-pg-owner",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          },
          {
            "selector": "#db-pg-password-user",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          }
        ]
      },
      {
        "applicableRoutes": [
          "/whm/databases/mongodb"
        ],
        "optionalSelectors": [
          "#db-pg-owner",
          "#db-pg-password-user",
          "[data-db-fact=\"active\"]",
          "[data-db-fact=\"configPath\"]",
          "[data-db-fact=\"configState\"]",
          "[data-db-fact=\"databases\"]",
          "[data-db-fact=\"enabled\"]",
          "[data-db-fact=\"family\"]",
          "[data-db-fact=\"installed\"]",
          "[data-db-fact=\"limit\"]",
          "[data-db-fact=\"observedAt\"]",
          "[data-db-fact=\"package\"]",
          "[data-db-fact=\"phppgadmin\"]",
          "[data-db-fact=\"postgresql\"]",
          "[data-db-fact=\"running\"]",
          "[data-db-fact=\"session\"]",
          "[data-db-fact=\"signon\"]",
          "[data-db-fact=\"state\"]",
          "[data-db-fact=\"ticket\"]",
          "[data-db-fact=\"unit\"]",
          "[data-db-fact=\"version\"]",
          "[data-db-rows=\"databases\"]",
          "[data-db-rows=\"packages\"]",
          "[data-db-rows=\"roles\"]"
        ],
        "rootSelector": "[data-db-engine=\"whm-mongodb\"]",
        "id": "db-engines:variants:6",
        "elements": [
          {
            "selector": "#db-pg-owner",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          },
          {
            "selector": "#db-pg-password-user",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "required": false
          }
        ]
      }
    ],
    "elements": [
      {
        "selector": "#db-pg-owner",
        "tags": [
          "select"
        ],
        "occurrence": "first",
        "required": false
      },
      {
        "selector": "#db-pg-password-user",
        "tags": [
          "select"
        ],
        "occurrence": "first",
        "required": false
      },
      {
        "selector": "[data-db-action=\"refresh\"]",
        "tags": [
          "button"
        ],
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/email/forwarders"
    ],
    "id": "account-forwarders",
    "optionalSelectors": [
      "[data-forwarder-status]"
    ],
    "requiredSelectors": [
      "[data-forwarder-rows]"
    ],
    "rootSelector": "[data-forwarder-workspace]",
    "elements": [
      {
        "selector": "[data-forwarder-rows]",
        "tags": [
          "tbody",
          "thead",
          "tfoot"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-forwarder-create]",
        "tags": [
          "form"
        ],
        "occurrence": "first",
        "required": false,
        "attributes": {}
      }
    ],
    "variants": [],
    "conditionalRequirements": [
      {
        "id": "forwarder-write-form-when-manage",
        "rootAttributes": {
          "data-forwarder-manage": "true"
        },
        "requiredSelectors": [
          "[data-forwarder-create]"
        ],
        "elements": [
          {
            "selector": "[data-forwarder-create]",
            "tags": [
              "form"
            ],
            "occurrence": "first"
          }
        ]
      }
    ],
    "nestedScopes": [
      {
        "id": "forwarder-create-named-controls",
        "rootSelector": "[data-forwarder-create]",
        "rootRequired": false,
        "requiredSelectors": [
          "[name=\"source\"],[id=\"source\"]",
          "[name=\"destinations\"],[id=\"destinations\"]",
          "[name=\"rejectMessage\"],[id=\"rejectMessage\"]"
        ],
        "elements": [
          {
            "selector": "[name=\"source\"],[id=\"source\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "email",
              "dir": "ltr",
              "maxlength": "254"
            }
          },
          {
            "selector": "[name=\"destinations\"],[id=\"destinations\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "email",
              "dir": "ltr",
              "multiple": ""
            }
          },
          {
            "selector": "[name=\"rejectMessage\"],[id=\"rejectMessage\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first",
            "attributes": {
              "dir": "ltr",
              "maxlength": "200"
            }
          }
        ],
        "variants": [
          {
            "id": "forwarder-create-named-controls:named-control:0",
            "rootSelector": "[data-forwarder-create]",
            "rootRequired": true,
            "scopeSelector": "[name=\"source\"],[id=\"source\"]",
            "scopeCount": 1
          },
          {
            "id": "forwarder-create-named-controls:named-control:1",
            "rootSelector": "[data-forwarder-create]",
            "rootRequired": true,
            "scopeSelector": "[name=\"destinations\"],[id=\"destinations\"]",
            "scopeCount": 1
          },
          {
            "id": "forwarder-create-named-controls:named-control:2",
            "rootSelector": "[data-forwarder-create]",
            "rootRequired": true,
            "scopeSelector": "[name=\"rejectMessage\"],[id=\"rejectMessage\"]",
            "scopeCount": 1
          }
        ],
        "optionalSelectors": [
          "[data-forwarder-destination-field]",
          "[data-forwarder-reject-field]"
        ]
      }
    ]
  },
  {
    "applicableRoutes": [
      "/mail/settings/calendars"
    ],
    "id": "mail-calendar-controls",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-calendar-refresh]",
      "[data-calendar-new]",
      "[data-calendar-save]",
      "[data-calendar-delete]",
      "[data-calendar-event-new]",
      "[data-calendar-event-save]",
      "[data-calendar-event-delete]",
      "[data-calendar-share]",
      "[data-calendar-import]",
      "[data-calendar-export]",
      "[data-calendar-download]",
      "[data-calendar-name]",
      "[data-calendar-color]",
      "[data-calendar-timezone]",
      "[data-calendar-event-summary]",
      "[data-calendar-event-description]",
      "[data-calendar-event-location]",
      "[data-calendar-event-start]",
      "[data-calendar-event-end]",
      "[data-calendar-event-timezone]",
      "[data-calendar-share-principal]"
    ],
    "rootSelector": "[data-mail-calendar]",
    "elements": [
      {
        "selector": "[data-calendar-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-new]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-delete]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-event-new]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-event-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-event-delete]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-share]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-import]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-export]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-download]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-name]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-color]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-timezone]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-event-summary]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-event-description]",
        "tags": [
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-event-location]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-event-start]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-event-end]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-event-timezone]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calendar-share-principal]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/mail/calendar"
    ],
    "id": "mail-calendar-view-controls",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-calview-grid]",
      "[data-calview-scroll]",
      "[data-calview-status]",
      "[data-calview-range]",
      "[data-calview-zone]",
      "[data-calview-legend]",
      "[data-calview-unplaced]",
      "[data-calview-detail]",
      "[data-calview-detail-heading]",
      "[data-calview-agenda]",
      "[data-calview-agenda-list]",
      "[data-calview-event]",
      "[data-calview-event-facts]",
      "[data-calview-editor]",
      "[data-calview-nav=\"prev\"]",
      "[data-calview-nav=\"today\"]",
      "[data-calview-nav=\"next\"]",
      "[data-calview-mode=\"month\"]",
      "[data-calview-mode=\"week\"]",
      "[data-calview-mode=\"day\"]",
      "[data-calview-new]",
      "[data-calview-refresh]",
      "[data-calview-close]",
      "[data-calview-agenda-new]",
      "[data-calview-edit]",
      "[data-calview-delete]",
      "[data-calview-save]",
      "[data-calview-cancel]",
      "[data-calview-field=\"calendar\"]",
      "[data-calview-field=\"summary\"]",
      "[data-calview-field=\"all-day\"]",
      "[data-calview-field=\"start-date\"]",
      "[data-calview-field=\"start-time\"]",
      "[data-calview-field=\"end-date\"]",
      "[data-calview-field=\"end-time\"]",
      "[data-calview-field=\"timezone\"]",
      "[data-calview-field=\"location\"]",
      "[data-calview-field=\"notes\"]"
    ],
    "rootSelector": "[data-mail-calendar-view]",
    "elements": [
      {
        "selector": "[data-calview-nav=\"prev\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-nav=\"today\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-nav=\"next\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-mode=\"month\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-mode=\"week\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-mode=\"day\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-new]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-close]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-agenda-new]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-edit]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-delete]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-cancel]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-field=\"summary\"]",
        "tags": [
          "input",
          "select",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-field=\"start-date\"]",
        "tags": [
          "input",
          "select",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-field=\"start-time\"]",
        "tags": [
          "input",
          "select",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-field=\"end-date\"]",
        "tags": [
          "input",
          "select",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-field=\"end-time\"]",
        "tags": [
          "input",
          "select",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-field=\"timezone\"]",
        "tags": [
          "input",
          "select",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-field=\"location\"]",
        "tags": [
          "input",
          "select",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-field=\"notes\"]",
        "tags": [
          "input",
          "select",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-field=\"calendar\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-calview-field=\"all-day\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/mail/calendar"
    ],
    "id": "mail-calendar-day-focus",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-mail-calendar-view]",
    "scopeSelector": "[data-calview-grid]"
  },
  {
    "applicableRoutes": [
      "/mail/contacts"
    ],
    "id": "mail-contact-groups-controls",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-groups-status]",
      "[data-groups-select]",
      "[data-groups-name]",
      "[data-groups-members]",
      "[data-groups-contact]",
      "[data-groups-membership]",
      "[data-groups-reload]",
      "[data-groups-new]",
      "[data-groups-save]",
      "[data-groups-delete]",
      "[data-groups-membership-save]"
    ],
    "rootSelector": "[data-mail-contact-groups]",
    "elements": [
      {
        "selector": "[data-groups-select]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-groups-members]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-groups-contact]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-groups-membership]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-groups-name]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-groups-reload]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-groups-new]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-groups-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-groups-delete]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-groups-membership-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/mail/contacts"
    ],
    "id": "mail-contacts-buttons",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-contact-save]",
      "[data-contact-discard]",
      "[data-contact-delete]",
      "[data-contact-new]",
      "[data-contact-refresh]",
      "[data-contact-reload]"
    ],
    "rootSelector": "[data-mail-contacts]",
    "elements": [
      {
        "selector": "[data-contact-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-contact-discard]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-contact-delete]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-contact-new]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-contact-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-contact-reload]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/mail/contacts"
    ],
    "id": "mail-contacts-fields",
    "optionalSelectors": [],
    "parentRootSelector": "[data-mail-contacts]",
    "requiredSelectors": [
      "[name=\"fullName\"]",
      "[name=\"email\"]",
      "[name=\"phone\"]",
      "[name=\"organization\"]",
      "[name=\"title\"]"
    ],
    "rootSelector": "[data-contact-form]",
    "elements": [
      {
        "selector": "[name=\"fullName\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"email\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"phone\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"organization\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"title\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/mail/tools/disk-usage"
    ],
    "id": "mail-usage-facts",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mail-usage-fact=\"observed\"]",
      "[data-mail-usage-fact=\"quota-used\"]",
      "[data-mail-usage-fact=\"quota-limit\"]",
      "[data-mail-usage-fact=\"total\"]"
    ],
    "rootSelector": "[data-mail-disk-usage]"
  },
  {
    "applicableRoutes": [
      "/mail/folders"
    ],
    "id": "mail-folder-facts",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mail-folders-fact=\"observed\"]",
      "[data-mail-folders-fact=\"count\"]"
    ],
    "rootSelector": "[data-mail-folders]"
  },
  {
    "applicableRoutes": [
      "/mail/settings/preferences"
    ],
    "id": "mail-preferences-selects",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"density\"]",
      "[name=\"messagesPerPage\"]",
      "[name=\"replyIdentityId\"]",
      "[name=\"dateFormat\"]"
    ],
    "rootSelector": "[data-mail-preferences]",
    "elements": [
      {
        "selector": "[name=\"density\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"messagesPerPage\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"replyIdentityId\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"dateFormat\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/mail/search"
    ],
    "id": "mail-search-detail-fields",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mail-search-subject]",
      "[data-mail-search-from]",
      "[data-mail-search-to]",
      "[data-mail-search-date]",
      "[data-mail-search-body]",
      "[data-mail-search-truncated]"
    ],
    "rootSelector": "[data-mail-search-workspace]"
  },
  {
    "applicableRoutes": [
      "/mail/settings/spam"
    ],
    "id": "mail-spam-fields",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"inherit\"]",
      "[name=\"enabled\"]",
      "[name=\"spamBoxEnabled\"]",
      "[name=\"addHeaderScore\"]",
      "[name=\"allowlist\"]",
      "[name=\"blocklist\"]"
    ],
    "rootSelector": "[data-mail-spam]",
    "elements": [
      {
        "selector": "[name=\"inherit\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"enabled\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"spamBoxEnabled\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"addHeaderScore\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"allowlist\"]",
        "tags": [
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"blocklist\"]",
        "tags": [
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/mail/tools/track-delivery"
    ],
    "id": "mail-track-facts",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mail-track-fact=\"observed\"]",
      "[data-mail-track-fact=\"window\"]"
    ],
    "rootSelector": "[data-mail-track-delivery]"
  },
  {
    "applicableRoutes": [
      "/mail/settings/autoresponder",
      "/mail/compose"
    ],
    "id": "mail-vacation-buttons",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-vacation-open]",
      "[data-vacation-save]",
      "[data-vacation-refresh]",
      "[data-vacation-reload]",
      "[data-vacation-cancel]"
    ],
    "rootSelector": "[data-mail-vacation]",
    "elements": [
      {
        "selector": "[data-vacation-open]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-vacation-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-vacation-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-vacation-reload]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-vacation-cancel]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/mail/settings/autoresponder",
      "/mail/compose"
    ],
    "id": "mail-vacation-fields",
    "optionalSelectors": [],
    "parentRootSelector": "[data-mail-vacation]",
    "requiredSelectors": [
      "[name=\"subject\"]",
      "[name=\"body\"]",
      "[name=\"htmlBody\"]",
      "[name=\"startDate\"]",
      "[name=\"endDate\"]",
      "[name=\"replyIntervalHours\"]"
    ],
    "rootSelector": "[data-vacation-form]",
    "elements": [
      {
        "selector": "[name=\"subject\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"body\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"htmlBody\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"startDate\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"endDate\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"replyIntervalHours\"]",
        "tags": [
          "input",
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/email/archive"
    ],
    "id": "mailx-archive-facts",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mailx-archive-fact=\"saved\"]",
      "[data-mailx-archive-fact=\"host\"]",
      "[data-mailx-archive-fact=\"state\"]",
      "[data-mailx-archive-fact=\"observed-at\"]",
      "[data-mailx-archive-fact=\"updated\"]"
    ],
    "rootSelector": "[data-mailx-archive]"
  },
  {
    "applicableRoutes": [
      "/email/calendars-contacts"
    ],
    "id": "mailx-collections-controls",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mailx-calendar-mailbox]",
      "[data-mailx-calendar-target]",
      "[data-mailx-calendar-name]",
      "[data-mailx-calendar-color]",
      "[data-mailx-calendar-timezone]",
      "[data-mailx-calendar-save]",
      "[data-mailx-calendar-delete]",
      "[data-mailx-calendar-status]",
      "[data-mailx-collections-form]",
      "[data-mailx-collections-mailbox]",
      "[data-mailx-collections-default]",
      "[data-mailx-descriptions]",
      "[data-mailx-collections-save]",
      "[data-mailx-collections-refresh]",
      "[data-mailx-collections-status]",
      "[data-mailx-address-books]",
      "[data-mailx-task-lists]"
    ],
    "rootSelector": "[data-mailx-collections]",
    "elements": [
      {
        "selector": "[data-mailx-calendar-mailbox]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-mailx-calendar-target]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-mailx-collections-mailbox]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-mailx-collections-default]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-mailx-calendar-name]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-mailx-calendar-color]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-mailx-calendar-timezone]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-mailx-calendar-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-mailx-calendar-delete]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-mailx-collections-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-mailx-collections-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/email/mailing-lists"
    ],
    "id": "mailx-list-delivery-facts",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mailx-tools-fact=\"delivery\"]",
      "[data-mailx-tools-fact=\"observed-at\"]"
    ],
    "rootAttributes": {
      "data-mailx-tools-section": "lists"
    },
    "rootSelector": "[data-mailx-tools]"
  },
  {
    "applicableRoutes": [
      "/email/spam-filters"
    ],
    "id": "mailx-spam-delivery-facts",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mailx-tools-fact=\"engine\"]",
      "[data-mailx-tools-fact=\"wiring\"]",
      "[data-mailx-tools-fact=\"observed-at\"]"
    ],
    "rootAttributes": {
      "data-mailx-tools-section": "spam"
    },
    "rootSelector": "[data-mailx-tools]"
  },
  {
    "applicableRoutes": [
      "/whm/email/spam"
    ],
    "id": "mailx-whm-spam-fields",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mailx-field=\"enabled\"]",
      "[data-mailx-field=\"rejectScore\"]",
      "[data-mailx-field=\"headerScore\"]",
      "[data-mailx-field=\"greylisting\"]",
      "[data-mailx-field=\"greylistScore\"]",
      "[data-mailx-field=\"blockedDomains\"]"
    ],
    "rootAttributes": {
      "data-mailx-page": "spam"
    },
    "rootSelector": "[data-mailx-whm]"
  },
  {
    "applicableRoutes": [
      "/whm/email/relay"
    ],
    "id": "mailx-whm-relay-fields",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mailx-field=\"enabled\"]",
      "[data-mailx-field=\"host\"]",
      "[data-mailx-field=\"port\"]",
      "[data-mailx-field=\"username\"]",
      "[data-mailx-field=\"password\"]"
    ],
    "rootAttributes": {
      "data-mailx-page": "relay"
    },
    "rootSelector": "[data-mailx-whm]"
  },
  {
    "applicableRoutes": [
      "/whm/email/bcc"
    ],
    "id": "mailx-whm-bcc-fields",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mailx-field=\"alwaysBcc\"]",
      "[data-mailx-field=\"recipient\"]",
      "[data-mailx-field=\"sender\"]"
    ],
    "rootAttributes": {
      "data-mailx-page": "bcc"
    },
    "rootSelector": "[data-mailx-whm]"
  },
  {
    "applicableRoutes": [
      "/whm/email/marketing"
    ],
    "id": "mailx-whm-marketing-fields",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mailx-field=\"messageRateLimit\"]",
      "[data-mailx-field=\"recipientRateLimit\"]",
      "[data-mailx-field=\"recipientsPerMessage\"]",
      "[data-mailx-field=\"destinationRateDelay\"]",
      "[data-mailx-field=\"destinationConcurrency\"]",
      "[data-mailx-field=\"rateWindow\"]"
    ],
    "rootAttributes": {
      "data-mailx-page": "marketing"
    },
    "rootSelector": "[data-mailx-whm]"
  },
  {
    "applicableRoutes": [
      "/whm/email/spam",
      "/whm/email/relay",
      "/whm/email/bcc",
      "/whm/email/marketing"
    ],
    "id": "mailx-whm-common-facts",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mailx-fact=\"saved\"]",
      "[data-mailx-fact=\"host\"]",
      "[data-mailx-fact=\"state\"]",
      "[data-mailx-fact=\"observed-at\"]",
      "[data-mailx-fact=\"updated\"]"
    ],
    "rootSelector": "[data-mailx-whm]"
  },
  {
    "applicableRoutes": [
      "/whm/email/spam"
    ],
    "id": "mailx-whm-spam-facts",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mailx-fact=\"engine\"]",
      "[data-mailx-fact=\"wiring\"]"
    ],
    "rootAttributes": {
      "data-mailx-page": "spam"
    },
    "rootSelector": "[data-mailx-whm]"
  },
  {
    "applicableRoutes": [
      "/domains"
    ],
    "id": "domain-create-fields",
    "optionalSelectors": [],
    "parentRootSelector": "[data-domain-workspace]",
    "requiredSelectors": [
      "[name=\"name\"]",
      "[name=\"kind\"]",
      "[name=\"parentId\"]",
      "[name=\"docRoot\"]",
      "[name=\"siteType\"]"
    ],
    "rootSelector": "[data-domain-create]",
    "elements": [
      {
        "selector": "[name=\"name\"]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"kind\"]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"docRoot\"]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"siteType\"]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"parentId\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/domains"
    ],
    "conditionalRequirements": [
      {
        "requiredSelectors": [
          "[data-domain-create-submit]",
          "[data-domain-create-cancel]"
        ],
        "whenScopeMounted": "[data-domain-create]",
        "elements": [
          {
            "selector": "[data-domain-create-submit]",
            "tags": [
              "button"
            ],
            "attributes": {},
            "occurrence": "first"
          },
          {
            "selector": "[data-domain-create-cancel]",
            "tags": [
              "button"
            ],
            "attributes": {},
            "occurrence": "first"
          }
        ]
      },
      {
        "requiredSelectors": [
          "[data-domain-save-root]",
          "[data-domain-cancel-edit]"
        ],
        "whenScopeMounted": "[data-domain-settings-form]",
        "elements": [
          {
            "selector": "[data-domain-save-root]",
            "tags": [
              "button"
            ],
            "attributes": {},
            "occurrence": "first"
          },
          {
            "selector": "[data-domain-cancel-edit]",
            "tags": [
              "button"
            ],
            "attributes": {},
            "occurrence": "first"
          }
        ]
      }
    ],
    "id": "domain-workspace-buttons",
    "optionalSelectors": [
      "[data-domain-refresh]",
      "[data-domain-reload]",
      "[data-domain-create-submit]",
      "[data-domain-create-cancel]",
      "[data-domain-save-root]",
      "[data-domain-cancel-edit]"
    ],
    "requiredSelectors": [],
    "rootSelector": "[data-domain-workspace]"
  },
  {
    "applicableRoutes": [
      "/login"
    ],
    "conditionalRequirements": [
      {
        "documentAttributes": {
          "data-mfa-mode": {
            "not": "disabled"
          }
        },
        "requiredSelectors": [
          "[name=\"totpCode\"]",
          "[name=\"recoveryCode\"]"
        ]
      }
    ],
    "id": "login-credentials",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"username\"]",
      "[name=\"password\"]"
    ],
    "rootSelector": "[data-login-form]",
    "rootRequired": false
  },
  {
    "applicableRoutes": [
      "/whm/security/sign-in",
      "/security/account",
      "/mail/settings/security"
    ],
    "id": "login-setup",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"password\"]"
    ],
    "rootSelector": "[data-auth-setup-form]",
    "rootRequired": false
  },
  {
    "applicableRoutes": [
      "/whm/security/sign-in",
      "/security/account",
      "/mail/settings/security"
    ],
    "id": "login-enrollment",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"code\"]"
    ],
    "rootSelector": "[data-auth-enroll-form]",
    "rootRequired": false
  },
  {
    "applicableRoutes": [
      "/login"
    ],
    "id": "login-password-change",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"currentPassword\"]",
      "[name=\"newPassword\"]",
      "[name=\"confirmPassword\"]"
    ],
    "rootSelector": "[data-auth-password-form]",
    "rootRequired": false
  },
  {
    "applicableRoutes": [
      "/login",
      "/whm/security/sign-in",
      "/security/account",
      "/mail/settings/security"
    ],
    "id": "login-view-switches",
    "optionalSelectors": [
      "[data-auth-totp-qr-field]",
      "[data-auth-enrollment]",
      "[data-auth-recovery]",
      "[data-auth-password-change]",
      "[data-auth-cancel]",
      "[data-login-factor=\"totp\"]",
      "[data-login-factor=\"recovery\"]",
      "[data-auth-mfa-fields]",
      "[data-auth-enrollment-details]"
    ],
    "requiredSelectors": [],
    "rootSelector": "document",
    "rootRequired": false
  },
  {
    "applicableRoutes": [
      "/mail/compose"
    ],
    "id": "compose-recipient-chips",
    "optionalSelectors": [
      "[data-mail-chip=\"to\"]",
      "[data-mail-chip=\"cc\"]",
      "[data-mail-chip=\"bcc\"]"
    ],
    "requiredSelectors": [],
    "rootSelector": "[data-mail-send=\"true\"]"
  },
  {
    "applicableRoutes": [
      "/mail/inbox",
      "/mail/sent",
      "/mail/drafts",
      "/mail/trash"
    ],
    "id": "mail-folder-template-projections",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-mail-folder-workspace=\"true\"]",
    "semanticRelations": [
      {
        "selector": "[data-mail-time] time",
        "ancestorHook": "[data-mail-time]",
        "tag": "time"
      }
    ],
    "templateScopes": [
      {
        "requiredSelectors": [
          "[data-mail-name]",
          "[data-mail-subject]",
          "[data-mail-preview]",
          "[data-mail-time] time"
        ],
        "templateSelector": "[data-mail-folder-row-template]"
      },
      {
        "conditionalSelectors": [
          {
            "scopeSelector": "[data-mail-attachments]",
            "requiredSelectors": [
              "h3"
            ]
          }
        ],
        "requiredSelectors": [
          "[data-mail-detail-subject]",
          "[data-mail-detail-name]",
          "[data-mail-detail-from]",
          "[data-mail-detail-to]",
          "[data-mail-detail-cc]",
          "[data-mail-detail-date]",
          "[data-mail-detail-avatar]",
          "[data-mail-detail-auth]"
        ],
        "templateSelector": "[data-mail-folder-reading-template]"
      }
    ]
  },
  {
    "applicableRoutes": [],
    "id": "reconcile-stage-projections",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-stage=\"render\"]",
      "[data-stage=\"test\"]",
      "[data-stage=\"switch\"]",
      "[data-stage=\"reload\"]",
      "[data-stage=\"verify\"]"
    ],
    "rootSelector": "#xp-reconcile-banner",
    "routeScope": {
      "kind": "authenticated",
      "surfaces": [
        "xpanel",
        "xwhm",
        "xmail"
      ]
    },
    "rootRequired": false
  },
  {
    "applicableRoutes": [],
    "id": "overlay-focus-policy",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "document",
    "routeScope": {
      "kind": "non-login-non-error-documents",
      "surfaces": [
        "xpanel",
        "xwhm",
        "xmail"
      ]
    },
    "qualifiedOnly": false
  },
  {
    "applicableRoutes": [
      "/whm/accounts/new"
    ],
    "id": "account-creation-optional-selection",
    "optionalSelectors": [
      "[name=\"ownerId\"]",
      "[name=\"shell\"]"
    ],
    "requiredSelectors": [],
    "rootSelector": "[data-create-account-form]"
  },
  {
    "applicableRoutes": [
      "/whm/accounts/new"
    ],
    "id": "account-creation-required-values",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"username\"]",
      "[name=\"primaryDomain\"]",
      "[name=\"planId\"]",
      "[name=\"ipv6\"]"
    ],
    "rootSelector": "[data-create-account-form]"
  },
  {
    "applicableRoutes": [
      "/domains/site-settings"
    ],
    "id": "userdata-config-fields",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"userIni\"]",
      "[name=\"customHeaders\"]",
      "[name=\"nginxInclude\"]",
      "[name=\"apacheInclude\"]"
    ],
    "rootSelector": "[data-userdata-form]"
  },
  {
    "applicableRoutes": [
      "/email/accounts",
      "/files/ftp"
    ],
    "id": "mailbox-password-dialog-field",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"password\"]"
    ],
    "rootSelector": "[data-mailbox-password-dialog]",
    "rootRequired": false
  },
  {
    "applicableRoutes": [
      "/email/accounts",
      "/files/ftp"
    ],
    "id": "mailbox-quota-dialog-field",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"mailboxQuotaMb\"]"
    ],
    "rootSelector": "[data-mailbox-quota-dialog]",
    "rootRequired": false
  },
  {
    "applicableRoutes": [
      "/email/accounts",
      "/files/ftp",
      "/databases/mariadb",
      "/whm/plans"
    ],
    "id": "tool-dialog-root-forwarder",
    "optionalSelectors": [
      "[data-mailbox-password-dialog]",
      "[data-mailbox-quota-dialog]",
      "[data-database-delete-dialog]",
      "[data-plan-delete-dialog]"
    ],
    "requiredSelectors": [],
    "rootSelector": "document"
  },
  {
    "applicableRoutes": [
      "/whm/email/outbound"
    ],
    "id": "mail-ip-config-fields",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"mode\"]",
      "[name=\"defaultIpv4\"]",
      "[name=\"defaultIpv6\"]",
      "[name=\"defaultHelo\"]"
    ],
    "rootSelector": "[data-mail-ip-config-form]",
    "rootRequired": false
  },
  {
    "applicableRoutes": [],
    "id": "command-palette-history-targets",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-cmdk-favorites]",
      "[data-cmdk-favorites-section]",
      "[data-cmdk-recents]",
      "[data-cmdk-recents-section]"
    ],
    "rootSelector": "[data-xp-cmdk]",
    "routeScope": {
      "kind": "authenticated",
      "surfaces": [
        "xpanel",
        "xwhm",
        "xmail"
      ]
    }
  },
  {
    "applicableRoutes": [
      "/whm/accounts/new",
      "/email/accounts"
    ],
    "conditionalRequirements": [
      {
        "requiredSelectors": [
          "[data-account-create-status]"
        ],
        "rootSelector": "[data-create-account-form]",
        "semanticTag": "form",
        "whenButtonSelector": "[data-account-generate-password]"
      },
      {
        "requiredSelectors": [
          "[data-mailbox-status]"
        ],
        "rootSelector": "[data-mailbox-form]",
        "semanticTag": "form",
        "whenButtonSelector": "[data-password-generate]"
      }
    ],
    "id": "password-generator-status-projections",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "document"
  },
  {
    "applicableRoutes": [
      "/whm/server/file-sharing"
    ],
    "id": "ops-file-sharing-dynamic-48",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-ops-shares-action=\"apply\"]",
      "[data-ops-shares-action=\"read\"]"
    ],
    "rootSelector": "[data-ops-shares-workspace]",
    "elements": [
      {
        "selector": "[data-ops-shares-action=\"apply\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ops-shares-action=\"read\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/server/file-sharing"
    ],
    "id": "ops-file-sharing-dynamic-57",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-ops-shares-fact=\"count\"]",
      "[data-ops-shares-fact=\"nfs\"]",
      "[data-ops-shares-fact=\"managed\"]"
    ],
    "rootSelector": "[data-ops-shares-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/panel/integrations"
    ],
    "id": "ops-integrations-dynamic-48",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-ops-int-action=\"read\"]"
    ],
    "rootSelector": "[data-ops-integrations-workspace]",
    "elements": [
      {
        "selector": "[data-ops-int-action=\"read\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/panel/integrations"
    ],
    "id": "ops-integrations-dynamic-56",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-ops-int-fact=\"scheme\"]",
      "[data-ops-int-fact=\"egress\"]",
      "[data-ops-int-fact=\"secrets\"]"
    ],
    "rootSelector": "[data-ops-integrations-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/server/nodes"
    ],
    "id": "ops-nodes-dynamic-36",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-ops-nodes-label]",
      "[data-ops-nodes-host]",
      "[data-ops-nodes-port]",
      "[data-ops-nodes-fingerprint]",
      "[data-ops-nodes-role]"
    ],
    "rootSelector": "[data-ops-nodes-workspace]",
    "elements": [
      {
        "selector": "[data-ops-nodes-label]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ops-nodes-host]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ops-nodes-port]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ops-nodes-fingerprint]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ops-nodes-role]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/server/nodes"
    ],
    "id": "ops-nodes-dynamic-37",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-ops-nodes-action=\"read\"]"
    ],
    "rootSelector": "[data-ops-nodes-workspace]",
    "elements": [
      {
        "selector": "[data-ops-nodes-action=\"read\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/server/nodes"
    ],
    "id": "ops-nodes-dynamic-47",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-ops-nodes-fact=\"count\"]",
      "[data-ops-nodes-fact=\"this\"]",
      "[data-ops-nodes-fact=\"channel\"]"
    ],
    "rootSelector": "[data-ops-nodes-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/software/containers/engine"
    ],
    "id": "sw-containers-dynamic-114",
    "optionalSelectors": [],
    "requiredSelectors": [
      "tbody[data-sw-facts]",
      "tbody[data-sw-images]",
      "tbody[data-sw-registries]",
      "tbody[data-sw-networks]",
      "tbody[data-sw-volumes]"
    ],
    "rootSelector": "[data-sw-container-engine]"
  },
  {
    "applicableRoutes": [
      "/whm/software/deployments"
    ],
    "id": "sw-deployments-dynamic-43",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-sw-dep-status]",
      "[data-sw-dep-refresh]",
      "[data-sw-dep-account]",
      "[data-sw-dep-repositories]",
      "[data-sw-dep-commits]",
      "[data-sw-dep-pull]",
      "[data-sw-dep-branch]",
      "[data-sw-dep-files]",
      "[data-sw-dep-head]",
      "[data-sw-dep-native]",
      "[data-sw-dep-path]",
      "[data-sw-dep-remote]",
      "[data-sw-dep-tree]"
    ],
    "rootSelector": "[data-sw-deployments]",
    "elements": [
      {
        "selector": "[data-sw-dep-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sw-dep-account]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sw-dep-pull]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/software/optimize"
    ],
    "id": "sw-optimize-dynamic-18",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-sw-optimize-compression]",
      "[data-sw-optimize-min]",
      "[data-sw-optimize-proxied]",
      "[data-sw-optimize-cache]"
    ],
    "rootSelector": "[data-sw-optimize]"
  },
  {
    "applicableRoutes": [
      "/whm/accounts/health"
    ],
    "id": "whm-account-health-dynamic-71",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-health-run]",
      "[data-whm-health-status]",
      "[data-whm-health-list]",
      "[data-whm-health-filter]",
      "[data-whm-health-search]",
      "[data-whm-health-select-all]",
      "[data-whm-health-recheck]",
      "[data-whm-health-selection]",
      "[data-whm-health-count-accounts]",
      "[data-whm-health-count-affected]",
      "[data-whm-health-count-problems]",
      "[data-whm-health-count-unavailable]",
      "[data-whm-health-observed-at]"
    ],
    "rootSelector": "[data-whm-health-workspace]",
    "elements": [
      {
        "selector": "[data-whm-health-run]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-health-filter]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-health-search]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-health-select-all]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-health-recheck]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/accounts/health"
    ],
    "id": "whm-account-health-dynamic-224",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-health-workspace]",
    "scopeSelector": "[data-whm-health-list]"
  },
  {
    "applicableRoutes": [
      "/whm/accounts/health"
    ],
    "id": "whm-account-health-dynamic-266",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-health-workspace]",
    "scopeSelector": "[data-whm-health-list]"
  },
  {
    "applicableRoutes": [
      "/whm/backups/destinations"
    ],
    "id": "whm-backup-destinations-dynamic-43",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-destination-field=\"name\"]",
      "[data-destination-field=\"kind\"]",
      "[data-destination-field=\"endpoint\"]",
      "[data-destination-field=\"bucket\"]",
      "[data-destination-field=\"region\"]",
      "[data-destination-field=\"pathPrefix\"]",
      "[data-destination-field=\"username\"]",
      "[data-destination-field=\"retentionDays\"]",
      "[data-destination-field=\"credentialRef\"]"
    ],
    "rootSelector": "[data-whm-backup-destinations]"
  },
  {
    "applicableRoutes": [
      "/whm/backups/files"
    ],
    "id": "whm-backup-files-dynamic-80",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-backup-files-status]",
      "[data-backup-files-account]",
      "[data-backup-files-archives]",
      "[data-backup-files-entries]",
      "[data-backup-files-path]",
      "[data-backup-files-up]",
      "[data-backup-files-selection]",
      "[data-backup-files-folder]",
      "[data-backup-files-destination]",
      "[data-backup-files-clear]",
      "[data-backup-files-preview]",
      "[data-backup-files-review]",
      "[data-backup-files-ack]",
      "[data-backup-files-restore]",
      "[data-backup-files-results]",
      "[data-backup-files-continue]",
      "[data-backup-files-steps]",
      "[data-backup-files-archive]",
      "[data-backup-files-count-failed]",
      "[data-backup-files-count-pending]",
      "[data-backup-files-count-present]",
      "[data-backup-files-count-refused]",
      "[data-backup-files-count-restore]",
      "[data-backup-files-count-restored]",
      "[data-backup-files-count-skipped]",
      "[data-backup-files-integrity]",
      "[data-backup-files-planned]",
      "[data-backup-files-quota]",
      "[data-backup-files-sha256]",
      "[data-backup-files-writer]"
    ],
    "rootSelector": "[data-whm-backup-files-workspace]",
    "elements": [
      {
        "selector": "[data-backup-files-account]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-files-up]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-files-destination]",
        "tags": [
          "fieldset"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-files-clear]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-files-preview]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-files-ack]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-files-restore]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-files-continue]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/backups",
      "/whm/backups/restore"
    ],
    "id": "whm-backups-dynamic-104",
    "optionalSelectors": [],
    "requiredSelectors": [
      "#backup-layout-destination-enabled",
      "#backup-layout-destination-name",
      "#backup-layout-destination-retention",
      "#backup-layout-policy-enabled",
      "#backup-layout-policy-cron",
      "#backup-layout-daily-copies",
      "#backup-layout-include-databases",
      "#backup-layout-include-mail",
      "#backup-layout-weekly-copies",
      "#backup-layout-include-dns",
      "#backup-layout-include-control",
      "#backup-layout-start-time",
      "#backup-layout-destination-endpoint",
      "#backup-layout-destination-prefix",
      "#backup-layout-destination-bucket",
      "#backup-layout-destination-region",
      "#backup-layout-destination-user"
    ],
    "rootAttributeExclusions": {
      "data-backup-read-state": "denied"
    },
    "rootSelector": "[data-approved-whm-backups]",
    "elements": [
      {
        "selector": "#backup-layout-destination-enabled",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-destination-name",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-destination-retention",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-policy-enabled",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-policy-cron",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-daily-copies",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-include-databases",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-include-mail",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-weekly-copies",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-include-dns",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-include-control",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-start-time",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-destination-endpoint",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-destination-prefix",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-destination-bucket",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-destination-region",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-destination-user",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/backups",
      "/whm/backups/restore"
    ],
    "id": "whm-backups-dynamic-105",
    "optionalSelectors": [],
    "requiredSelectors": [
      "#backup-layout-destination-kind",
      "#backup-layout-frequency",
      "#backup-layout-policy-compress"
    ],
    "rootAttributeExclusions": {
      "data-backup-read-state": "denied"
    },
    "rootSelector": "[data-approved-whm-backups]",
    "elements": [
      {
        "selector": "#backup-layout-destination-kind",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-frequency",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "#backup-layout-policy-compress",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/backups",
      "/whm/backups/restore"
    ],
    "id": "whm-backups-dynamic-106",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-backup-action=\"save-schedule\"]",
      "[data-backup-action=\"discard-schedule\"]",
      "[data-backup-action=\"save-destination\"]",
      "[data-backup-action=\"refresh\"]",
      "[data-backup-action=\"all-accounts\"]",
      "[data-backup-action=\"selected-accounts\"]",
      "[data-backup-action=\"new-destination\"]"
    ],
    "rootAttributeExclusions": {
      "data-backup-read-state": "denied"
    },
    "rootSelector": "[data-approved-whm-backups]",
    "elements": [
      {
        "selector": "[data-backup-action=\"save-schedule\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-action=\"discard-schedule\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-action=\"save-destination\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-action=\"refresh\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-action=\"all-accounts\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-action=\"selected-accounts\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-backup-action=\"new-destination\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/backups",
      "/whm/backups/restore"
    ],
    "id": "whm-backups-dynamic-371",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-backup-action=\"run-now\"]",
      "[data-backup-action=\"rerun-account\"]",
      "[data-backup-action=\"run-log\"]",
      "[data-backup-action=\"restore-run\"]",
      "[data-backup-action=\"restore-back\"]",
      "[data-backup-action=\"restore-continue\"]",
      "[data-backup-action=\"restore-review\"]",
      "[data-backup-action=\"restore-apply\"]",
      "[data-backup-action=\"test-sftp\"]"
    ],
    "rootAttributeExclusions": {
      "data-backup-read-state": "denied"
    },
    "rootSelector": "[data-approved-whm-backups]",
    "elements": [
      {
        "selector": "[data-backup-action=\"run-now\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "every"
      },
      {
        "selector": "[data-backup-action=\"rerun-account\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "every"
      },
      {
        "selector": "[data-backup-action=\"run-log\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "every"
      },
      {
        "selector": "[data-backup-action=\"restore-run\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "every"
      },
      {
        "selector": "[data-backup-action=\"restore-back\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "every"
      },
      {
        "selector": "[data-backup-action=\"restore-continue\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "every"
      },
      {
        "selector": "[data-backup-action=\"restore-review\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "every"
      },
      {
        "selector": "[data-backup-action=\"restore-apply\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "every"
      },
      {
        "selector": "[data-backup-action=\"test-sftp\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "every"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/software/composer"
    ],
    "id": "whm-composer-dynamic-29",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-composer-version]",
      "[data-composer-observed]",
      "[data-composer-account]",
      "[data-composer-directory]",
      "[data-composer-php]",
      "[data-composer-manifest]",
      "[data-composer-lock]",
      "[data-composer-vendor]",
      "[data-composer-match]"
    ],
    "rootSelector": "[data-whm-composer]"
  },
  {
    "applicableRoutes": [
      "/whm/databases/tuning"
    ],
    "id": "whm-database-tuning-dynamic-87",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-db-tuning-fact=\"version\"]",
      "[data-db-tuning-fact=\"observedAt\"]",
      "[data-db-tuning-fact=\"Uptime\"]",
      "[data-db-tuning-fact=\"Uptime_since_flush_status\"]"
    ],
    "rootSelector": "[data-whm-database-tuning]"
  },
  {
    "applicableRoutes": [
      "/whm/databases",
      "/whm/databases/users",
      "/whm/databases/processes",
      "/whm/databases/servers"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/databases"
        ],
        "requiredSelectors": [
          "[data-whm-db-fact=\"version\"]",
          "[data-whm-db-fact=\"observedAt\"]",
          "[data-whm-db-fact=\"schemaCount\"]",
          "[data-whm-db-fact=\"totalSizeBytes\"]",
          "[data-whm-db-fact=\"Uptime\"]",
          "[data-whm-db-fact=\"Threads_connected\"]",
          "[data-whm-db-fact=\"Threads_running\"]",
          "[data-whm-db-fact=\"Connections\"]",
          "[data-whm-db-fact=\"Max_used_connections\"]",
          "[data-whm-db-fact=\"Aborted_connects\"]",
          "[data-whm-db-fact=\"Questions\"]",
          "[data-whm-db-fact=\"Slow_queries\"]",
          "[data-whm-db-fact=\"accounts\"]",
          "[data-whm-db-fact=\"databases\"]",
          "[data-whm-db-fact=\"trashedDatabases\"]",
          "[data-whm-db-fact=\"users\"]",
          "[data-whm-db-fact=\"grants\"]",
          "[data-whm-db-fact=\"savedOnly\"]",
          "[data-whm-db-fact=\"serverOnly\"]"
        ],
        "rootAttributes": {
          "data-db-kind": "overview"
        }
      },
      {
        "applicableRoutes": [
          "/whm/databases/users"
        ],
        "requiredSelectors": [
          "[data-whm-db-fact=\"observedAt\"]",
          "[data-whm-db-fact=\"savedOnly\"]",
          "[data-whm-db-fact=\"serverOnly\"]"
        ],
        "rootAttributes": {
          "data-db-kind": "users"
        }
      },
      {
        "applicableRoutes": [
          "/whm/databases/processes"
        ],
        "requiredSelectors": [
          "[data-whm-db-fact=\"observedAt\"]",
          "[data-whm-db-fact=\"count\"]"
        ],
        "rootAttributes": {
          "data-db-kind": "processes"
        }
      },
      {
        "applicableRoutes": [
          "/whm/databases/servers"
        ],
        "requiredSelectors": [
          "[data-whm-db-fact=\"protocol\"]",
          "[data-whm-db-fact=\"clientSocket\"]",
          "[data-whm-db-fact=\"observedAt\"]",
          "[data-whm-db-fact=\"port\"]",
          "[data-whm-db-fact=\"socket\"]",
          "[data-whm-db-fact=\"bind_address\"]",
          "[data-whm-db-fact=\"skip_networking\"]",
          "[data-whm-db-fact=\"max_connections\"]"
        ],
        "rootAttributes": {
          "data-db-kind": "servers"
        }
      }
    ],
    "id": "whm-databases-dynamic-136",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-databases]"
  },
  {
    "applicableRoutes": [
      "/whm/databases",
      "/whm/databases/users",
      "/whm/databases/processes",
      "/whm/databases/servers"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/databases"
        ],
        "requiredSelectors": [
          "[data-whm-db-rows=\"accounts\"]",
          "[data-whm-db-rows=\"databases\"]"
        ],
        "rootAttributes": {
          "data-db-kind": "overview"
        }
      },
      {
        "applicableRoutes": [
          "/whm/databases/users"
        ],
        "requiredSelectors": [
          "[data-whm-db-rows=\"users\"]"
        ],
        "rootAttributes": {
          "data-db-kind": "users"
        }
      },
      {
        "applicableRoutes": [
          "/whm/databases/processes"
        ],
        "requiredSelectors": [
          "[data-whm-db-rows=\"processes\"]"
        ],
        "rootAttributes": {
          "data-db-kind": "processes"
        }
      },
      {
        "applicableRoutes": [
          "/whm/databases/servers"
        ],
        "requiredSelectors": [
          "[data-whm-db-rows=\"engines\"]"
        ],
        "rootAttributes": {
          "data-db-kind": "servers"
        }
      }
    ],
    "id": "whm-databases-dynamic-143",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-databases]"
  },
  {
    "applicableRoutes": [
      "/whm/dns"
    ],
    "id": "whm-dns-dynamic-23",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-dns-refresh]",
      "[data-dns-add-zone]",
      "[data-dns-add-record]",
      "[data-dns-save]",
      "[data-dns-delete]"
    ],
    "rootSelector": "[data-whm-dns-workspace] [data-dns-editor]",
    "elements": [
      {
        "selector": "[data-dns-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-dns-add-zone]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-dns-add-record]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-dns-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-dns-delete]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/dns/more"
    ],
    "id": "whm-dns-tools-dynamic-166",
    "optionalSelectors": [],
    "perMatchRequired": [
      {
        "selector": "[data-whm-dns-tools-page=\"compare\"]",
        "eachAttributes": {
          "data-direction": [
            "previous",
            "next"
          ]
        }
      },
      {
        "selector": "[data-whm-dns-tools-page=\"nameservers\"]",
        "eachAttributes": {
          "data-direction": [
            "previous",
            "next"
          ]
        }
      }
    ],
    "requiredSelectors": [
      "[data-whm-dns-tools-page=\"compare\"]",
      "[data-whm-dns-tools-page=\"nameservers\"]"
    ],
    "rootSelector": "[data-whm-dns-tools-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/domains"
    ],
    "id": "whm-domains-dynamic-54",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-domain-refresh]",
      "[data-whm-domain-reload]",
      "[data-whm-domain-create-submit]",
      "[data-whm-domain-create-cancel]",
      "[data-whm-domain-save-root]",
      "[data-whm-domain-cancel]",
      "[data-whm-domain-remove]"
    ],
    "rootSelector": "[data-whm-domains-workspace]",
    "elements": [
      {
        "selector": "[data-whm-domain-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-domain-reload]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-domain-create-submit]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-domain-create-cancel]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-domain-save-root]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-domain-cancel]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-domain-remove]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/domains"
    ],
    "id": "whm-domains-dynamic-55",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"docRoot\"]",
      "[name=\"siteType\"]",
      "[name=\"parentId\"]",
      "[name=\"name\"]",
      "[name=\"kind\"]"
    ],
    "rootSelector": "[data-whm-domains-workspace]",
    "scopeSelector": "[data-whm-domain-create]",
    "elements": [
      {
        "selector": "[name=\"docRoot\"]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"siteType\"]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"parentId\"]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"name\"]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"kind\"]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"docRoot\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/security/firewall"
    ],
    "id": "whm-firewall-dynamic-117",
    "lookupScope": {
      "kind": "descendant",
      "selector": "[data-whm-ops-section=\"firewall-rule-categories\"]"
    },
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-firewall-panel=\"port\"] table",
      "[data-whm-firewall-panel=\"ip\"] table",
      "[data-whm-firewall-panel=\"forward\"] table"
    ],
    "rootAttributes": {
      "data-operation-state": "qualified"
    },
    "rootSelector": "[data-approved-whm-operations=\"/whm/security/firewall\"][data-operation-state=\"qualified\"]"
  },
  {
    "applicableRoutes": [
      "/whm/security/firewall"
    ],
    "id": "whm-firewall-dynamic-164",
    "lookupScope": {
      "kind": "descendant",
      "selector": "[data-whm-ops-section=\"firewall-rule-categories\"]"
    },
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"firewall-prefix-name\"]",
      "[name=\"firewall-prefix-file\"]",
      "[name=\"firewall-prefix-action\"]",
      "[name=\"firewall-prefix-ports\"]"
    ],
    "rootAttributes": {
      "data-operation-state": "qualified"
    },
    "rootSelector": "[data-approved-whm-operations=\"/whm/security/firewall\"][data-operation-state=\"qualified\"]",
    "scopeSelector": "[data-whm-firewall-panel=\"prefix-list\"]",
    "elements": [
      {
        "selector": "[name=\"firewall-prefix-name\"]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"firewall-prefix-file\"]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"firewall-prefix-action\"]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"firewall-prefix-ports\"]",
        "tags": [
          "input",
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/security/firewall"
    ],
    "id": "whm-firewall-dynamic-172",
    "lookupScope": {
      "kind": "descendant",
      "selector": "[data-whm-ops-section=\"firewall-rule-categories\"]"
    },
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-firewall-action=\"upload-list\"]",
      "[data-firewall-action=\"replace-list\"]"
    ],
    "rootAttributes": {
      "data-operation-state": "qualified"
    },
    "rootSelector": "[data-approved-whm-operations=\"/whm/security/firewall\"][data-operation-state=\"qualified\"]",
    "scopeSelector": "[data-whm-firewall-panel=\"prefix-list\"]"
  },
  {
    "applicableRoutes": [
      "/whm/security/firewall"
    ],
    "id": "whm-firewall-dynamic-175",
    "lookupScope": {
      "kind": "descendant",
      "selector": "[data-whm-ops-section=\"firewall-rule-categories\"]"
    },
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"firewall-prefix-name\"]",
      "[name=\"firewall-prefix-file\"]",
      "[name=\"firewall-prefix-ports\"]",
      "[name=\"firewall-prefix-action\"]",
      "[name=\"firewall-unban-address\"]"
    ],
    "rootAttributes": {
      "data-operation-state": "qualified"
    },
    "rootSelector": "[data-approved-whm-operations=\"/whm/security/firewall\"][data-operation-state=\"qualified\"]",
    "elements": [
      {
        "selector": "[name=\"firewall-unban-address\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/services/ftp-log-analysis"
    ],
    "id": "whm-ftp-log-dynamic-115",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-ftp-log-fact=\"observed\"]",
      "[data-ftp-log-fact=\"window\"]",
      "[data-ftp-log-fact=\"records\"]",
      "[data-ftp-log-fact=\"matched\"]"
    ],
    "rootSelector": "[data-whm-ftp-log]"
  },
  {
    "applicableRoutes": [
      "/whm/services/ftp-log-analysis"
    ],
    "id": "whm-ftp-log-dynamic-137",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-ftp-log-table=\"users\"]",
      "[data-ftp-log-table=\"clients\"]",
      "[data-ftp-log-table=\"bursts\"]"
    ],
    "rootSelector": "[data-whm-ftp-log]"
  },
  {
    "applicableRoutes": [
      "/whm/jobs"
    ],
    "id": "whm-jobs-dynamic-119",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-jobs-field=\"reference\"]",
      "[data-whm-jobs-field=\"kind\"]",
      "[data-whm-jobs-field=\"summary\"]",
      "[data-whm-jobs-field=\"status\"]",
      "[data-whm-jobs-field=\"progress\"]",
      "[data-whm-jobs-field=\"actor\"]",
      "[data-whm-jobs-field=\"created\"]",
      "[data-whm-jobs-field=\"started\"]",
      "[data-whm-jobs-field=\"finished\"]",
      "[data-whm-jobs-field=\"cancellation\"]"
    ],
    "rootSelector": "[data-whm-jobs-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/email/delivery",
      "/whm/email/monitor"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/email/delivery"
        ],
        "requiredSelectors": [
          "[data-mail-log-fact=\"observed\"]",
          "[data-mail-log-fact=\"window\"]",
          "[data-mail-log-fact=\"matched\"]"
        ],
        "rootAttributes": {
          "data-whm-mail-log": "delivery"
        }
      },
      {
        "applicableRoutes": [
          "/whm/email/monitor"
        ],
        "requiredSelectors": [
          "[data-mail-log-fact=\"observed\"]",
          "[data-mail-log-fact=\"window\"]",
          "[data-mail-log-fact=\"messages\"]",
          "[data-mail-log-fact=\"records\"]"
        ],
        "rootAttributes": {
          "data-whm-mail-log": "monitor"
        }
      }
    ],
    "id": "whm-mail-log-dynamic-118",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-mail-log]"
  },
  {
    "applicableRoutes": [
      "/whm/email/delivery",
      "/whm/email/monitor"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/email/monitor"
        ],
        "requiredSelectors": [
          "[data-mail-monitor-table=\"senders\"]",
          "[data-mail-monitor-table=\"domains\"]",
          "[data-mail-monitor-table=\"deferrals\"]"
        ],
        "rootAttributes": {
          "data-whm-mail-log": "monitor"
        }
      }
    ],
    "id": "whm-mail-log-dynamic-192",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-mail-log]"
  },
  {
    "applicableRoutes": [
      "/whm/email/quality"
    ],
    "id": "whm-mail-quality-dynamic-109",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-mail-quality-fact=\"hostname\"]",
      "[data-whm-mail-quality-fact=\"helo\"]",
      "[data-whm-mail-quality-fact=\"addresses\"]",
      "[data-whm-mail-quality-fact=\"checked\"]",
      "[data-whm-mail-quality-fact=\"problems\"]",
      "[data-whm-mail-quality-fact=\"unavailable\"]",
      "[data-whm-mail-quality-fact=\"checked-at\"]"
    ],
    "rootSelector": "[data-whm-mail-quality-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/email/queue"
    ],
    "id": "whm-mail-queue-dynamic-58",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-mail-queue-filter=\"queue\"]",
      "[data-whm-mail-queue-filter=\"text\"]",
      "[data-whm-mail-queue-filter=\"age\"]"
    ],
    "rootSelector": "[data-whm-mail-queue-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/email/queue"
    ],
    "id": "whm-mail-queue-dynamic-92",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-mail-queue-count=\"incoming\"]",
      "[data-whm-mail-queue-count=\"active\"]",
      "[data-whm-mail-queue-count=\"deferred\"]",
      "[data-whm-mail-queue-count=\"hold\"]",
      "[data-whm-mail-queue-count=\"maildrop\"]"
    ],
    "rootSelector": "[data-whm-mail-queue-workspace]"
  },
  {
    "additionalConditionalRequired": [
      {
        "requiredSelectors": [
          "[data-whm-mail-server-changes]"
        ],
        "rootAttributes": {
          "data-mail-server-can-manage": "true"
        }
      }
    ],
    "applicableRoutes": [
      "/whm/email/server",
      "/whm/email/routing",
      "/whm/email/outbound"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/email/server"
        ],
        "requiredSelectors": [
          "[data-whm-mail-server-settings]",
          "[data-whm-mail-server-services]"
        ],
        "rootAttributes": {
          "data-mail-server-page": "server"
        }
      },
      {
        "applicableRoutes": [
          "/whm/email/routing"
        ],
        "requiredSelectors": [
          "[data-whm-mail-server-settings]",
          "[data-whm-mail-server-domains]"
        ],
        "rootAttributes": {
          "data-mail-server-page": "routing"
        }
      },
      {
        "applicableRoutes": [
          "/whm/email/outbound"
        ],
        "requiredSelectors": [
          "[data-whm-mail-server-settings]",
          "[data-whm-mail-server-services]"
        ],
        "rootAttributes": {
          "data-mail-server-page": "outbound"
        }
      }
    ],
    "id": "whm-mail-server-dynamic-107",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-mail-server-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/email/server",
      "/whm/email/routing",
      "/whm/email/outbound"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/email/server"
        ],
        "requiredSelectors": [
          "[data-whm-mail-server-fact=\"postfix\"]",
          "[data-whm-mail-server-fact=\"master\"]",
          "[data-whm-mail-server-fact=\"dovecot\"]",
          "[data-whm-mail-server-fact=\"desired\"]",
          "[data-whm-mail-server-fact=\"observed-at\"]"
        ],
        "rootAttributes": {
          "data-mail-server-page": "server"
        }
      },
      {
        "applicableRoutes": [
          "/whm/email/routing"
        ],
        "requiredSelectors": [
          "[data-whm-mail-server-fact=\"postfix\"]",
          "[data-whm-mail-server-fact=\"desired\"]",
          "[data-whm-mail-server-fact=\"observed-at\"]"
        ],
        "rootAttributes": {
          "data-mail-server-page": "routing"
        }
      },
      {
        "applicableRoutes": [
          "/whm/email/outbound"
        ],
        "requiredSelectors": [
          "[data-whm-mail-server-fact=\"postfix\"]",
          "[data-whm-mail-server-fact=\"master\"]",
          "[data-whm-mail-server-fact=\"desired\"]",
          "[data-whm-mail-server-fact=\"observed-at\"]"
        ],
        "rootAttributes": {
          "data-mail-server-page": "outbound"
        }
      }
    ],
    "id": "whm-mail-server-dynamic-121",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-mail-server-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/monitoring/io",
      "/whm/accounts/bandwidth"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/monitoring/io"
        ],
        "requiredSelectors": [
          "[data-whm-metering-fact=\"observed\"]",
          "[data-whm-metering-fact=\"read\"]",
          "[data-whm-metering-fact=\"write\"]",
          "[data-whm-metering-fact=\"iops\"]",
          "[data-whm-metering-fact=\"latency\"]",
          "[data-whm-metering-fact=\"pressure\"]",
          "[data-whm-metering-fact=\"host\"]"
        ],
        "rootAttributes": {
          "data-whm-metering": "io"
        }
      },
      {
        "applicableRoutes": [
          "/whm/accounts/bandwidth"
        ],
        "requiredSelectors": [
          "[data-whm-metering-fact=\"month\"]",
          "[data-whm-metering-fact=\"since\"]",
          "[data-whm-metering-fact=\"updated\"]",
          "[data-whm-metering-fact=\"pending\"]",
          "[data-whm-metering-fact=\"web\"]",
          "[data-whm-metering-fact=\"mail\"]",
          "[data-whm-metering-fact=\"ftp\"]"
        ],
        "rootAttributes": {
          "data-whm-metering": "bandwidth"
        }
      }
    ],
    "id": "whm-metering-dynamic-58",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-metering]"
  },
  {
    "applicableRoutes": [
      "/whm/monitoring/io",
      "/whm/accounts/bandwidth"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/monitoring/io"
        ],
        "requiredSelectors": [
          "[data-whm-metering-rows=\"devices\"]",
          "[data-whm-metering-rows=\"io\"]"
        ],
        "rootAttributes": {
          "data-whm-metering": "io"
        }
      },
      {
        "applicableRoutes": [
          "/whm/accounts/bandwidth"
        ],
        "requiredSelectors": [
          "[data-whm-metering-rows=\"bandwidth\"]"
        ],
        "rootAttributes": {
          "data-whm-metering": "bandwidth"
        }
      }
    ],
    "id": "whm-metering-dynamic-60",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-metering]"
  },
  {
    "applicableRoutes": [
      "/whm/monitoring/alerts"
    ],
    "id": "whm-monitoring-alerts-dynamic-112",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-alerts-status]",
      "[data-whm-alerts-eval-status]",
      "[data-whm-alerts-save-status]",
      "[data-whm-alerts-form]",
      "[data-whm-alerts-results]",
      "[data-whm-alerts-log]",
      "[data-whm-alerts-evaluate]",
      "[data-whm-alerts-save]",
      "[data-whm-alerts-reload]",
      "[data-whm-alerts-quiet]",
      "[data-whm-alerts-quiet-start]",
      "[data-whm-alerts-quiet-end]"
    ],
    "rootSelector": "[data-whm-monitoring-alerts-workspace]",
    "elements": [
      {
        "selector": "[data-whm-alerts-evaluate]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-alerts-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-alerts-reload]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-alerts-quiet]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-alerts-quiet-start]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-alerts-quiet-end]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/monitoring/alerts"
    ],
    "id": "whm-monitoring-alerts-dynamic-119",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-alerts-enabled]",
      "[data-whm-alerts-range]"
    ],
    "rootSelector": "[data-whm-monitoring-alerts-workspace]",
    "scopeCount": 10,
    "scopeSelector": "[data-whm-alerts-rule]",
    "elements": [
      {
        "selector": "[data-whm-alerts-enabled]",
        "tags": [
          "input"
        ],
        "attributes": {
          "type": "checkbox"
        },
        "occurrence": "first"
      }
    ],
    "conditionalRequired": [
      {
        "rootAttributes": {
          "data-whm-alerts-rule": {
            "oneOf": [
              "load",
              "memory",
              "swap",
              "disk-space",
              "disk-inodes",
              "certificates",
              "bandwidth"
            ]
          }
        },
        "requiredSelectors": [
          "[data-whm-alerts-threshold]"
        ],
        "elements": [
          {
            "selector": "[data-whm-alerts-threshold]",
            "tags": [
              "input"
            ],
            "attributes": {
              "type": "number"
            },
            "occurrence": "first"
          }
        ]
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/monitoring/alerts"
    ],
    "id": "whm-monitoring-alerts-dynamic-128",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-alerts-fact=\"updated\"]",
      "[data-whm-alerts-fact=\"updated-by\"]",
      "[data-whm-alerts-fact=\"notifications\"]",
      "[data-whm-alerts-fact=\"scheduler\"]",
      "[data-whm-alerts-fact=\"pending\"]",
      "[data-whm-alerts-fact=\"evaluated-at\"]",
      "[data-whm-alerts-fact=\"observed-at\"]",
      "[data-whm-alerts-fact=\"firing\"]",
      "[data-whm-alerts-fact=\"unavailable\"]",
      "[data-whm-alerts-fact=\"quiet\"]"
    ],
    "rootSelector": "[data-whm-monitoring-alerts-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/monitoring/processes",
      "/whm/monitoring/disk",
      "/whm/monitoring/logs",
      "/whm/monitoring/performance"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/monitoring/processes"
        ],
        "requiredSelectors": [
          "[data-whm-monitoring-shown]",
          "[data-whm-monitoring-observed-at]",
          "[data-whm-monitoring-total]"
        ],
        "rootAttributes": {
          "data-whm-monitoring": "processes"
        }
      },
      {
        "applicableRoutes": [
          "/whm/monitoring/disk"
        ],
        "requiredSelectors": [
          "[data-whm-monitoring-observed-at]",
          "[data-whm-monitoring-inodes]",
          "[data-whm-monitoring-quota-mount]"
        ],
        "rootAttributes": {
          "data-whm-monitoring": "disk"
        }
      },
      {
        "applicableRoutes": [
          "/whm/monitoring/logs"
        ],
        "requiredSelectors": [
          "[data-whm-monitoring-observed-at]",
          "[data-whm-monitoring-shown]"
        ],
        "rootAttributes": {
          "data-whm-monitoring": "logs"
        }
      },
      {
        "applicableRoutes": [
          "/whm/monitoring/performance"
        ],
        "requiredSelectors": [
          "[data-whm-monitoring-observed-range]",
          "[data-whm-monitoring-samples]",
          "[data-whm-monitoring-bucket]"
        ],
        "rootAttributes": {
          "data-whm-monitoring": "performance"
        }
      }
    ],
    "id": "whm-monitoring-dynamic-118",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-monitoring]"
  },
  {
    "applicableRoutes": [
      "/whm/monitoring/processes",
      "/whm/monitoring/disk",
      "/whm/monitoring/logs",
      "/whm/monitoring/performance"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/monitoring/performance"
        ],
        "requiredSelectors": [
          "[data-whm-monitoring-chart=\"cpuPercent\"] figcaption",
          "[data-whm-monitoring-chart=\"memoryMb\"] figcaption",
          "[data-whm-monitoring-chart=\"load1\"] figcaption",
          "[data-whm-monitoring-chart=\"processes\"] figcaption",
          "[data-whm-monitoring-chart=\"diskMb\"] figcaption"
        ],
        "rootAttributes": {
          "data-whm-monitoring": "performance"
        }
      }
    ],
    "id": "whm-monitoring-dynamic-340",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-monitoring]"
  },
  {
    "applicableRoutes": [
      "/whm/panel/notifications"
    ],
    "id": "whm-panel-notifications-dynamic-71",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-notifications-field=\"updated\"]",
      "[data-whm-notifications-field=\"updatedBy\"]",
      "[data-whm-notifications-field=\"signingKey\"]",
      "[data-whm-notifications-field=\"test\"]"
    ],
    "rootSelector": "[data-whm-panel-notifications-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/software/php"
    ],
    "id": "whm-php-dynamic-91",
    "lookupScope": {
      "kind": "closest",
      "selector": "[data-whm-detail-route=\"/whm/software/php\"]"
    },
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"php-selected-version\"]",
      "[name=\"php-extension-version\"]",
      "[name=\"php-version\"]",
      "[name=\"php-exception-account\"]"
    ],
    "rootSelector": "[data-whm-php-workspace]",
    "elements": [
      {
        "selector": "[name=\"php-selected-version\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"php-extension-version\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"php-version\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[name=\"php-exception-account\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/software/php"
    ],
    "id": "whm-php-dynamic-141",
    "lookupScope": {
      "kind": "closest",
      "selector": "[data-whm-detail-route=\"/whm/software/php\"]"
    },
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-php-action=\"confirm-remove\"]",
      "[data-php-action=\"add-exception\"]",
      "[data-php-action=\"grant-exception\"]",
      "[data-php-action=\"set-default\"]",
      "[data-php-action=\"reinstall-version\"]",
      "[data-php-action=\"remove-version\"]",
      "[data-php-action=\"cancel-remove\"]",
      "[data-php-action=\"install-version\"]",
      "[data-php-action=\"apply-ini\"]",
      "[data-php-action=\"discard-ini\"]"
    ],
    "rootSelector": "[data-whm-php-workspace]",
    "elements": [
      {
        "selector": "[data-php-action=\"confirm-remove\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-php-action=\"add-exception\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-php-action=\"grant-exception\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-php-action=\"set-default\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-php-action=\"reinstall-version\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-php-action=\"remove-version\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-php-action=\"cancel-remove\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-php-action=\"install-version\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-php-action=\"apply-ini\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-php-action=\"discard-ini\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/software/php"
    ],
    "id": "whm-php-dynamic-144",
    "lookupScope": {
      "kind": "closest",
      "selector": "[data-whm-detail-route=\"/whm/software/php\"]"
    },
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-detail-section=\"php-versions\"]",
      "[data-whm-detail-section=\"php-install\"]",
      "[data-whm-detail-section=\"php-extensions\"]",
      "[data-whm-detail-section=\"php-configure\"]",
      "[data-whm-detail-section=\"php-functions\"]"
    ],
    "rootSelector": "[data-whm-php-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/software/php"
    ],
    "id": "whm-php-dynamic-201",
    "lookupScope": {
      "kind": "closest",
      "selector": "[data-whm-detail-route=\"/whm/software/php\"]"
    },
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"memory_limit\"]",
      "[name=\"upload_max_filesize\"]",
      "[name=\"post_max_size\"]",
      "[name=\"max_execution_time\"]",
      "[name=\"max_input_vars\"]"
    ],
    "rootSelector": "[data-whm-php-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/software/php"
    ],
    "id": "whm-php-dynamic-248",
    "lookupScope": {
      "kind": "closest",
      "selector": "[data-whm-detail-route=\"/whm/software/php\"]"
    },
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"memory_limit\"]",
      "[name=\"upload_max_filesize\"]",
      "[name=\"post_max_size\"]",
      "[name=\"max_execution_time\"]",
      "[name=\"max_input_vars\"]"
    ],
    "rootSelector": "[data-whm-php-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/software/php"
    ],
    "id": "whm-php-dynamic-276",
    "lookupScope": {
      "kind": "closest",
      "selector": "[data-whm-detail-route=\"/whm/software/php\"]"
    },
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"php-exception-account\"]",
      "[name=\"php-exception-reason\"]",
      "[name=\"php-exception-exec\"]",
      "[name=\"php-exception-shell_exec\"]",
      "[name=\"php-exception-system\"]",
      "[name=\"php-exception-passthru\"]",
      "[name=\"php-exception-proc_open\"]",
      "[name=\"php-exception-popen\"]"
    ],
    "rootSelector": "[data-whm-php-workspace]",
    "elements": [
      {
        "selector": "[name=\"php-exception-reason\"]",
        "tags": [
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/software/php"
    ],
    "id": "whm-php-dynamic-282",
    "lookupScope": {
      "kind": "closest",
      "selector": "[data-whm-detail-route=\"/whm/software/php\"]"
    },
    "optionalSelectors": [],
    "requiredSelectors": [
      "[name=\"php-exception-exec\"]",
      "[name=\"php-exception-shell_exec\"]",
      "[name=\"php-exception-system\"]",
      "[name=\"php-exception-passthru\"]",
      "[name=\"php-exception-proc_open\"]",
      "[name=\"php-exception-popen\"]"
    ],
    "rootSelector": "[data-whm-php-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/monitoring/repair"
    ],
    "id": "whm-repair-dynamic-84",
    "optionalSelectors": [
      "[data-whm-repair-remove-group]"
    ],
    "requiredSelectors": [
      "[data-whm-repair-diagnose]",
      "[data-whm-repair-status]",
      "[data-whm-repair-list]",
      "[data-whm-repair-preview]",
      "[data-whm-repair-start]",
      "[data-whm-repair-cancel]",
      "[data-whm-repair-job]",
      "[data-whm-repair-job-status]",
      "[data-whm-repair-job-link]",
      "[data-whm-repair-rerun]",
      "[data-whm-repair-preview-summary]",
      "[data-whm-repair-removals]",
      "[data-whm-repair-removals-text]",
      "[data-whm-repair-preview-evidence]",
      "[data-whm-repair-count-problem]",
      "[data-whm-repair-count-ok]",
      "[data-whm-repair-count-unavailable]",
      "[data-whm-repair-observed-at]",
      "[data-whm-repair-preview-install]",
      "[data-whm-repair-preview-remove]",
      "[data-whm-repair-preview-configure]",
      "[data-whm-repair-install-list]",
      "[data-whm-repair-install-group]",
      "[data-whm-repair-configure-list]",
      "[data-whm-repair-configure-group]",
      "[data-whm-repair-remove-list]"
    ],
    "rootSelector": "[data-whm-repair-workspace]",
    "elements": [
      {
        "selector": "[data-whm-repair-diagnose]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-repair-start]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-repair-cancel]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-repair-job-link]",
        "tags": [
          "a"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-repair-rerun]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/monitoring/health",
      "/whm/monitoring/limits"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/monitoring/health"
        ],
        "requiredSelectors": [
          "[data-whm-server-health-status]",
          "[data-whm-server-health-refresh]",
          "[data-whm-server-health-checks]",
          "[data-whm-server-health-thresholds]",
          "[data-whm-server-health-observed-at]",
          "[data-whm-server-health-count-ok]",
          "[data-whm-server-health-count-warning]",
          "[data-whm-server-health-count-problem]",
          "[data-whm-server-health-count-unavailable]"
        ],
        "rootAttributes": {
          "data-whm-server-health": "health"
        },
        "elements": [
          {
            "selector": "[data-whm-server-health-refresh]",
            "tags": [
              "button"
            ],
            "attributes": {},
            "occurrence": "first"
          }
        ]
      },
      {
        "applicableRoutes": [
          "/whm/monitoring/limits"
        ],
        "requiredSelectors": [
          "[data-whm-server-health-status]",
          "[data-whm-server-health-refresh]",
          "[data-whm-server-health-accounts]",
          "[data-whm-server-health-filter]",
          "[data-whm-server-health-search]",
          "[data-whm-server-health-empty]",
          "[data-whm-server-health-observed-at]",
          "[data-whm-server-health-sample-at]",
          "[data-whm-server-health-count-accounts]",
          "[data-whm-server-health-count-high]",
          "[data-whm-server-health-count-drift]"
        ],
        "rootAttributes": {
          "data-whm-server-health": "limits"
        },
        "elements": [
          {
            "selector": "[data-whm-server-health-refresh]",
            "tags": [
              "button"
            ],
            "attributes": {},
            "occurrence": "first"
          },
          {
            "selector": "[data-whm-server-health-filter]",
            "tags": [
              "select"
            ],
            "attributes": {},
            "occurrence": "first"
          },
          {
            "selector": "[data-whm-server-health-search]",
            "tags": [
              "input"
            ],
            "attributes": {},
            "occurrence": "first"
          }
        ]
      }
    ],
    "id": "whm-server-health-dynamic-116",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-server-health]"
  },
  {
    "applicableRoutes": [
      "/whm/monitoring/health",
      "/whm/monitoring/limits"
    ],
    "id": "whm-server-health-dynamic-299",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-server-health]",
    "scopeSelector": "[data-whm-server-health-accounts]"
  },
  {
    "applicableRoutes": [
      "/whm/server/cron",
      "/whm/server/networking",
      "/whm/server/role"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/server/cron"
        ],
        "requiredSelectors": [
          "[data-whm-server-observation-observed-at]",
          "[data-whm-server-observation-timer-total]",
          "[data-whm-server-observation-timer-panel]",
          "[data-whm-server-observation-timer-account]"
        ],
        "rootAttributes": {
          "data-whm-server-observation": "timers"
        }
      },
      {
        "applicableRoutes": [
          "/whm/server/networking"
        ],
        "requiredSelectors": [
          "[data-whm-server-observation-observed-at]",
          "[data-whm-server-observation-static-hostname]",
          "[data-whm-server-observation-saved-hostname]",
          "[data-whm-server-observation-hostname-comparison]",
          "[data-whm-server-observation-resolvers]"
        ],
        "rootAttributes": {
          "data-whm-server-observation": "network"
        }
      },
      {
        "applicableRoutes": [
          "/whm/server/role"
        ],
        "requiredSelectors": [
          "[data-whm-server-observation-saved-hostname]",
          "[data-whm-server-observation-engine]",
          "[data-whm-server-observation-setup-completed]",
          "[data-whm-server-observation-php-versions]",
          "[data-whm-server-observation-count-accounts]",
          "[data-whm-server-observation-count-domains]",
          "[data-whm-server-observation-count-mailboxes]",
          "[data-whm-server-observation-count-databases]",
          "[data-whm-server-observation-count-zones]",
          "[data-whm-server-observation-observed-at]"
        ],
        "rootAttributes": {
          "data-whm-server-observation": "role"
        }
      }
    ],
    "id": "whm-server-observation-dynamic-116",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-server-observation]"
  },
  {
    "applicableRoutes": [
      "/whm/server/cron",
      "/whm/server/networking",
      "/whm/server/role"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/server/cron"
        ],
        "requiredSelectors": [
          "[data-whm-server-observation-timer-rows]",
          "[data-whm-server-observation-cron-rows]",
          "[data-whm-server-observation-cron-status]"
        ],
        "rootAttributes": {
          "data-whm-server-observation": "timers"
        }
      },
      {
        "applicableRoutes": [
          "/whm/server/networking"
        ],
        "requiredSelectors": [
          "[data-whm-server-observation-interface-rows]",
          "[data-whm-server-observation-pool-rows]",
          "[data-whm-server-observation-unpooled-rows]",
          "[data-whm-server-observation-route-rows]"
        ],
        "rootAttributes": {
          "data-whm-server-observation": "network"
        }
      },
      {
        "applicableRoutes": [
          "/whm/server/role"
        ],
        "requiredSelectors": [
          "[data-whm-server-observation-component-rows]",
          "[data-whm-server-observation-service-rows]"
        ],
        "rootAttributes": {
          "data-whm-server-observation": "role"
        }
      }
    ],
    "id": "whm-server-observation-dynamic-117",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-server-observation]"
  },
  {
    "applicableRoutes": [
      "/whm/services/dns",
      "/whm/services/ftp",
      "/whm/services/certificates"
    ],
    "conditionalRequired": [
      {
        "applicableRoutes": [
          "/whm/services/dns"
        ],
        "requiredSelectors": [
          "[data-whm-service-detail-fact=\"observed-at\"]",
          "[data-whm-service-detail-fact=\"unit\"]",
          "[data-whm-service-detail-fact=\"state\"]",
          "[data-whm-service-detail-fact=\"control\"]",
          "[data-whm-service-detail-fact=\"version\"]",
          "[data-whm-service-detail-fact=\"zone-dir\"]",
          "[data-whm-service-detail-fact=\"rendered\"]",
          "[data-whm-service-detail-fact=\"present\"]"
        ],
        "rootAttributes": {
          "data-whm-service-detail-workspace": "dns"
        }
      },
      {
        "applicableRoutes": [
          "/whm/services/ftp"
        ],
        "requiredSelectors": [
          "[data-whm-service-detail-fact=\"observed-at\"]",
          "[data-whm-service-detail-fact=\"unit\"]",
          "[data-whm-service-detail-fact=\"state\"]",
          "[data-whm-service-detail-fact=\"tls\"]",
          "[data-whm-service-detail-fact=\"passive\"]",
          "[data-whm-service-detail-fact=\"accounts\"]",
          "[data-whm-service-detail-fact=\"conf-dir\"]"
        ],
        "rootAttributes": {
          "data-whm-service-detail-workspace": "ftp"
        }
      },
      {
        "applicableRoutes": [
          "/whm/services/certificates"
        ],
        "requiredSelectors": [
          "[data-whm-service-detail-fact=\"observed-at\"]",
          "[data-whm-service-detail-fact=\"hostname\"]",
          "[data-whm-service-detail-fact=\"observed\"]",
          "[data-whm-service-detail-fact=\"warnings\"]"
        ],
        "rootAttributes": {
          "data-whm-service-detail-workspace": "certificates"
        }
      }
    ],
    "id": "whm-service-detail-dynamic-108",
    "optionalSelectors": [],
    "requiredSelectors": [],
    "rootSelector": "[data-whm-service-detail-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/ssl"
    ],
    "id": "whm-ssl-dynamic-75",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-ssl-account]",
      "[data-ssl-domain]",
      "[data-ssl-renewal]",
      "[data-ssl-search]",
      "[data-ssl-account-filter]",
      "[data-ssl-status-filter]",
      "[data-ssl-chain]",
      "[data-ssl-key]",
      "[data-ssl-status]",
      "[data-ssl-rows]",
      "[data-ssl-refresh]",
      "[data-ssl-issue]",
      "[data-ssl-install]",
      "[data-ssl-detail]",
      "[data-ssl-facts]",
      "[data-ssl-install-limit]",
      "[data-ssl-clear-filters]"
    ],
    "rootSelector": "[data-whm-ssl]",
    "elements": [
      {
        "selector": "[data-ssl-account]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-domain]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-renewal]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-search]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-account-filter]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-status-filter]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-chain]",
        "tags": [
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-key]",
        "tags": [
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-issue]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-install]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/ssl/install"
    ],
    "id": "whm-ssl-install-dynamic-108",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-ssl-install-domain]",
      "[data-ssl-install-names]",
      "[data-ssl-install-certificate]",
      "[data-ssl-install-chain]",
      "[data-ssl-install-key]",
      "[data-ssl-install-checks]",
      "[data-ssl-install-status]",
      "[data-ssl-install-result]",
      "[data-ssl-install-facts]",
      "[data-ssl-install-refresh]",
      "[data-ssl-install-submit]",
      "[data-ssl-install-clear]",
      "[data-ssl-install-names-empty]"
    ],
    "rootSelector": "[data-whm-ssl-install]",
    "elements": [
      {
        "selector": "[data-ssl-install-domain]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-install-names]",
        "tags": [
          "fieldset"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-install-certificate]",
        "tags": [
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-install-chain]",
        "tags": [
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-install-key]",
        "tags": [
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-install-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-install-submit]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ssl-install-clear]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/support"
    ],
    "id": "whm-support-dynamic-93",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-support-fact=\"panel-version\"]",
      "[data-whm-support-fact=\"release-path\"]",
      "[data-whm-support-fact=\"os\"]",
      "[data-whm-support-fact=\"os-profile\"]",
      "[data-whm-support-fact=\"uptime\"]",
      "[data-whm-support-fact=\"node\"]",
      "[data-whm-support-fact=\"observed-at\"]",
      "[data-whm-support-fact=\"generation\"]",
      "[data-whm-support-fact=\"generation-activated\"]",
      "[data-whm-support-fact=\"generation-checksum\"]",
      "[data-whm-support-fact=\"drift\"]",
      "[data-whm-support-fact=\"manifest-id\"]"
    ],
    "rootSelector": "[data-whm-support-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/support"
    ],
    "id": "whm-support-dynamic-96",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-support-services]",
      "[data-whm-support-jobs]"
    ],
    "rootSelector": "[data-whm-support-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/support"
    ],
    "id": "whm-support-dynamic-134",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-support-included]",
      "[data-whm-support-excluded]",
      "[data-whm-support-redaction]"
    ],
    "rootSelector": "[data-whm-support-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/monitoring/traffic"
    ],
    "id": "whm-traffic-dynamic-35",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-traffic-table=\"interfaces\"]",
      "[data-traffic-table=\"domains\"]",
      "[data-traffic-table=\"accounts\"]"
    ],
    "rootSelector": "[data-whm-traffic]"
  },
  {
    "applicableRoutes": [
      "/whm/transfers",
      "/whm/transfers/server"
    ],
    "id": "whm-transfer-dynamic-28",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-transfer-field=\"transfer-resolution-target\"]",
      "[data-transfer-field=\"transfer-archive\"]",
      "[data-transfer-field=\"transfer-archive-target\"]",
      "[data-transfer-field=\"transfer-cpanel-host\"]",
      "[data-transfer-field=\"transfer-cpanel-port\"]",
      "[data-transfer-field=\"transfer-cpanel-fingerprint\"]",
      "[data-transfer-field=\"transfer-cpanel-user\"]",
      "[data-transfer-field=\"transfer-host\"]",
      "[data-transfer-field=\"transfer-fingerprint\"]",
      "[data-transfer-field=\"transfer-port\"]",
      "[data-transfer-field=\"transfer-user\"]"
    ],
    "rootSelector": "[data-transfer-workspace]",
    "elements": [
      {
        "selector": "[data-transfer-field=\"transfer-resolution-target\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-field=\"transfer-archive\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-field=\"transfer-archive-target\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-field=\"transfer-cpanel-host\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-field=\"transfer-cpanel-port\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-field=\"transfer-cpanel-fingerprint\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-field=\"transfer-cpanel-user\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-field=\"transfer-host\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-field=\"transfer-fingerprint\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-field=\"transfer-port\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-field=\"transfer-user\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/transfers",
      "/whm/transfers/server"
    ],
    "id": "whm-transfer-dynamic-29",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-transfer-refresh]",
      "[data-transfer-create]",
      "[data-transfer-discover]",
      "[data-transfer-select]",
      "[data-transfer-resolve]",
      "[data-transfer-review]",
      "[data-transfer-run]",
      "[data-transfer-stop]",
      "[data-transfer-cancel]",
      "[data-transfer-inspect]",
      "[data-transfer-fetch]",
      "[data-transfer-ssh-key]",
      "[data-transfer-import-run]",
      "[data-transfer-import-discard]"
    ],
    "rootSelector": "[data-transfer-workspace]",
    "elements": [
      {
        "selector": "[data-transfer-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-create]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-discover]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-select]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-resolve]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-review]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-run]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-stop]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-cancel]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-inspect]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-fetch]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-ssh-key]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-import-run]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-transfer-import-discard]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/transfers"
    ],
    "id": "whm-transfer-dynamic-213",
    "lookupScope": {
      "kind": "closest",
      "selector": "[data-whm-detail-route]"
    },
    "optionalSelectors": [],
    "requiredSelectors": [
      "tbody[data-transfer-inventory-rows]",
      "tbody[data-transfer-progress-rows]",
      "tbody[data-transfer-plan-rows]"
    ],
    "rootSelector": "[data-transfer-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/software/updates"
    ],
    "id": "whm-updates-dynamic-58",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-updates-action=\"read\"]",
      "[data-whm-updates-action=\"refresh\"]",
      "[data-whm-updates-action=\"security\"]",
      "[data-whm-updates-action=\"selected\"]",
      "[data-whm-updates-action=\"all\"]"
    ],
    "rootSelector": "[data-whm-updates-workspace]",
    "elements": [
      {
        "selector": "[data-whm-updates-action=\"read\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-updates-action=\"refresh\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-updates-action=\"security\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-updates-action=\"selected\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-updates-action=\"all\"]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/software/updates"
    ],
    "id": "whm-updates-dynamic-83",
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-whm-updates-fact=\"source\"]",
      "[data-whm-updates-fact=\"observed-at\"]",
      "[data-whm-updates-fact=\"total\"]",
      "[data-whm-updates-fact=\"security\"]",
      "[data-whm-updates-fact=\"kernel\"]",
      "[data-whm-updates-fact=\"held\"]",
      "[data-whm-updates-fact=\"reboot\"]",
      "[data-whm-updates-fact=\"writers\"]",
      "[data-whm-updates-fact=\"database\"]"
    ],
    "rootSelector": "[data-whm-updates-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/server/terminal",
      "/advanced/terminal"
    ],
    "conditionalRequirements": [
      {
        "requiredSelectors": [
          "[data-terminal-password]",
          "[data-terminal-reauth]",
          "[data-terminal-totp-field]",
          "[data-terminal-totp]"
        ],
        "rootAttributes": {
          "data-terminal-kind": "root",
          "data-terminal-can-use": "true"
        },
        "elements": [
          {
            "selector": "[data-terminal-reauth]",
            "tags": [
              "form"
            ],
            "attributes": {},
            "occurrence": "first"
          },
          {
            "selector": "[data-terminal-password]",
            "tags": [
              "input"
            ],
            "attributes": {},
            "occurrence": "first"
          },
          {
            "selector": "[data-terminal-totp]",
            "tags": [
              "input"
            ],
            "attributes": {},
            "occurrence": "first"
          }
        ]
      }
    ],
    "id": "ops-terminal-forwarded",
    "rootSelector": "[data-terminal-workspace]",
    "variants": [
      {
        "applicableRoutes": [
          "/whm/server/terminal"
        ],
        "id": "ops-terminal-forwarded:dispatch:0",
        "requiredSelectors": [],
        "rootAttributes": {
          "data-terminal-kind": "root"
        },
        "rootRequired": true,
        "rootSelector": "[data-terminal-workspace]"
      },
      {
        "applicableRoutes": [
          "/advanced/terminal"
        ],
        "id": "ops-terminal-forwarded:dispatch:1",
        "requiredSelectors": [],
        "rootAttributes": {
          "data-terminal-kind": "account"
        },
        "rootRequired": true,
        "rootSelector": "[data-terminal-workspace]"
      }
    ],
    "conditionalRequired": [
      {
        "rootAttributes": {
          "data-terminal-can-use": "true"
        },
        "requiredSelectors": [
          "[data-terminal-close]",
          "[data-terminal-command-form]",
          "[data-terminal-command]",
          "[data-terminal-empty]",
          "[data-terminal-exec-pill]",
          "[data-terminal-fact=\"absolute\"]",
          "[data-terminal-fact=\"execution\"]",
          "[data-terminal-fact=\"idle\"]",
          "[data-terminal-fact=\"second-factor\"]",
          "[data-terminal-open]",
          "[data-terminal-pill]",
          "[data-terminal-reason]",
          "[data-terminal-run]",
          "[data-terminal-screen]",
          "[data-terminal-session]",
          "[data-terminal-status]",
          "[data-terminal-unavailable]"
        ],
        "elements": [
          {
            "selector": "[data-terminal-open]",
            "tags": [
              "button"
            ],
            "attributes": {},
            "occurrence": "first"
          },
          {
            "selector": "[data-terminal-command]",
            "tags": [
              "input"
            ],
            "attributes": {},
            "occurrence": "first"
          },
          {
            "selector": "[data-terminal-run]",
            "tags": [
              "button"
            ],
            "attributes": {},
            "occurrence": "first"
          },
          {
            "selector": "[data-terminal-close]",
            "tags": [
              "button"
            ],
            "attributes": {},
            "occurrence": "first"
          }
        ]
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/security/waf"
    ],
    "id": "sec-kit-waf",
    "requiredSelectors": [
      "[data-sec-status]",
      "[data-sec-result]",
      "[data-sec-field=\"updated\"]",
      "[data-sec-field=\"lists-active\"]",
      "[data-sec-field=\"reconcile\"]",
      "[data-sec-field=\"modsec-state\"]",
      "[data-sec-field=\"nginx-connector\"]",
      "[data-sec-field=\"apache-module\"]",
      "[data-sec-field=\"rule-engine\"]",
      "[data-sec-field=\"crs-version\"]",
      "[data-sec-field=\"modsec-active\"]",
      "[data-sec-field=\"observed-at\"]",
      "[data-sec-input=\"rate\"]",
      "[data-sec-input=\"burst\"]",
      "[data-sec-input=\"rate-unlimited\"]",
      "[data-sec-input=\"body\"]",
      "[data-sec-input=\"denied\"]",
      "[data-sec-input=\"body-unlimited\"]",
      "[data-sec-input=\"deny-ips\"]",
      "[data-sec-input=\"deny-paths\"]",
      "[data-sec-input=\"deny-agents\"]",
      "[data-sec-input=\"modsecurity\"]",
      "[data-sec-action=\"refresh\"]",
      "[data-sec-action=\"save\"]"
    ],
    "rootAttributes": {
      "data-sec-page": "waf"
    },
    "rootSelector": "[data-sec-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/security/flood"
    ],
    "id": "sec-kit-flood",
    "requiredSelectors": [
      "[data-sec-status]",
      "[data-sec-result]",
      "[data-sec-field=\"updated\"]",
      "[data-sec-field=\"reconcile\"]",
      "[data-sec-field=\"kernel-state\"]",
      "[data-sec-field=\"observed-at\"]",
      "[data-sec-input=\"enabled\"]",
      "[data-sec-input=\"conn\"]",
      "[data-sec-input=\"ping\"]",
      "[data-sec-input=\"rate\"]",
      "[data-sec-input=\"burst\"]",
      "[data-sec-input=\"web-conn\"]",
      "[data-sec-rows=\"kernel\"]",
      "[data-sec-action=\"refresh\"]",
      "[data-sec-action=\"save\"]"
    ],
    "rootAttributes": {
      "data-sec-page": "flood"
    },
    "rootSelector": "[data-sec-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/security/panel-access"
    ],
    "id": "sec-kit-panel-access",
    "requiredSelectors": [
      "[data-sec-status]",
      "[data-sec-result]",
      "[data-sec-field=\"listener\"]",
      "[data-sec-field=\"address\"]",
      "[data-sec-field=\"enforcement\"]",
      "[data-sec-field=\"updated\"]",
      "[data-sec-input=\"xpanel\"]",
      "[data-sec-input=\"xwhm\"]",
      "[data-sec-input=\"xmail\"]",
      "[data-sec-action=\"refresh\"]",
      "[data-sec-action=\"save\"]"
    ],
    "rootAttributes": {
      "data-sec-page": "panel-access"
    },
    "rootSelector": "[data-sec-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/dns/providers"
    ],
    "id": "sec-kit-dns-providers",
    "requiredSelectors": [
      "[data-sec-status]",
      "[data-sec-result]",
      "[data-sec-field=\"zone-domain\"]",
      "[data-sec-field=\"zone-status\"]",
      "[data-sec-field=\"zone-ssl\"]",
      "[data-sec-field=\"zone-ns\"]",
      "[data-sec-field=\"zone-at\"]",
      "[data-sec-input=\"label\"]",
      "[data-sec-input=\"token\"]",
      "[data-sec-input=\"link-domain\"]",
      "[data-sec-input=\"link-account\"]",
      "[data-sec-rows=\"accounts\"]",
      "[data-sec-rows=\"links\"]",
      "[data-sec-rows=\"records\"]",
      "[data-sec-action=\"refresh\"]",
      "[data-sec-action=\"connect\"]",
      "[data-sec-action=\"link\"]"
    ],
    "rootAttributes": {
      "data-sec-page": "dns-providers"
    },
    "rootSelector": "[data-sec-workspace]"
  },
  {
    "applicableRoutes": [
      "/whm/dns/cluster"
    ],
    "id": "sec-kit-dns-cluster",
    "requiredSelectors": [
      "[data-sec-status]",
      "[data-sec-result]",
      "[data-sec-field=\"application\"]",
      "[data-sec-field=\"launch\"]",
      "[data-sec-field=\"primary\"]",
      "[data-sec-field=\"include-dir\"]",
      "[data-sec-field=\"axfr\"]",
      "[data-sec-field=\"updated\"]",
      "[data-sec-field=\"verify-peer\"]",
      "[data-sec-field=\"verify-counts\"]",
      "[data-sec-field=\"verify-at\"]",
      "[data-sec-input=\"peer-name\"]",
      "[data-sec-input=\"peer-address\"]",
      "[data-sec-rows=\"peers\"]",
      "[data-sec-rows=\"transfers\"]",
      "[data-sec-action=\"refresh\"]",
      "[data-sec-action=\"add-peer\"]",
      "[data-sec-action=\"apply\"]"
    ],
    "rootAttributes": {
      "data-sec-page": "dns-cluster"
    },
    "rootSelector": "[data-sec-workspace]"
  },
  {
    "applicableRoutes": [
      "/security/waf"
    ],
    "id": "sec-kit-account-waf",
    "requiredSelectors": [
      "[data-sec-status]",
      "[data-sec-result]",
      "[data-sec-field=\"modsec\"]",
      "[data-sec-field=\"crs-version\"]",
      "[data-sec-field=\"rate\"]",
      "[data-sec-field=\"body\"]",
      "[data-sec-field=\"denied\"]",
      "[data-sec-field=\"lists\"]",
      "[data-sec-rows=\"domains\"]",
      "[data-sec-action=\"refresh\"]"
    ],
    "rootAttributes": {
      "data-sec-page": "account-waf"
    },
    "rootSelector": "[data-sec-workspace]"
  },
  {
    "applicableRoutes": [
      "/domains/cloudflare"
    ],
    "id": "sec-kit-account-cloudflare",
    "requiredSelectors": [
      "[data-sec-status]",
      "[data-sec-result]",
      "[data-sec-field=\"zone-domain\"]",
      "[data-sec-field=\"zone-status\"]",
      "[data-sec-field=\"zone-ssl\"]",
      "[data-sec-field=\"zone-ns\"]",
      "[data-sec-field=\"zone-at\"]",
      "[data-sec-rows=\"domains\"]",
      "[data-sec-rows=\"records\"]",
      "[data-sec-action=\"refresh\"]"
    ],
    "rootAttributes": {
      "data-sec-page": "account-cloudflare"
    },
    "rootSelector": "[data-sec-workspace]"
  },
  {
    "applicableRoutes": [
      "/software/apps"
    ],
    "id": "sw-applications-forwarded",
    "requiredSelectors": [
      "[data-sw-apps-app-select]",
      "[data-sw-apps-capability]",
      "[data-sw-apps-catalog]",
      "[data-sw-apps-domain-select]",
      "[data-sw-apps-expires]",
      "[data-sw-apps-installed]",
      "[data-sw-apps-previous]",
      "[data-sw-apps-recovery]",
      "[data-sw-apps-refresh]",
      "[data-sw-apps-sequence]",
      "[data-sw-apps-status]",
      "[data-sw-apps-version-select]",
      "[data-sw-apps-version]"
    ],
    "rootSelector": "[data-sw-apps]",
    "elements": [
      {
        "selector": "[data-sw-apps-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sw-apps-domain-select]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sw-apps-app-select]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sw-apps-version-select]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/accounts/announcements"
    ],
    "id": "whm-announcements-forwarded",
    "requiredSelectors": [
      "[data-whm-announcements-cancel]",
      "[data-whm-announcements-editor-heading]",
      "[data-whm-announcements-empty]",
      "[data-whm-announcements-form]",
      "[data-whm-announcements-list-status]",
      "[data-whm-announcements-loading]",
      "[data-whm-announcements-preview-empty]",
      "[data-whm-announcements-refresh]",
      "[data-whm-announcements-rows]",
      "[data-whm-announcements-save-status]",
      "[data-whm-announcements-save]",
      "[data-whm-announcements-status]"
    ],
    "rootSelector": "[data-whm-announcements-workspace]",
    "elements": [
      {
        "selector": "[data-whm-announcements-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-announcements-form]",
        "tags": [
          "form"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-announcements-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-announcements-cancel]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/backups",
      "/whm/backups/restore"
    ],
    "id": "whm-backups-forwarded",
    "rootSelector": "[data-approved-whm-backups]",
    "conditionalRequired": [
      {
        "rootAttributes": {
          "data-backup-manage": "true"
        },
        "requiredSelectors": [
          "#backup-layout-restore-acknowledge",
          "#backup-layout-restore-databases",
          "#backup-layout-restore-dns",
          "#backup-layout-restore-home",
          "#backup-layout-restore-mail",
          "#backup-layout-restore-search",
          "[data-backup-difference-rows]",
          "[data-backup-difference=\"add\"]",
          "[data-backup-difference=\"databases\"]",
          "[data-backup-difference=\"differ\"]",
          "[data-backup-difference=\"keep\"]",
          "[data-backup-part-availability]",
          "[data-backup-restore-accounts]",
          "[data-backup-restore-runs]",
          "[data-backup-restore-status]",
          "[data-backup-run-failure]",
          "[data-backup-run-log]",
          "[data-backup-section=\"restore\"]",
          "[data-backup-sftp-status]",
          "[data-backup-snapshot-rows]",
          "[data-backup-summary=\"last\"]",
          "[data-backup-summary=\"local\"]",
          "[data-backup-summary=\"next\"]",
          "[data-backup-summary=\"remote\"]"
        ],
        "rootAttributeExclusions": {
          "data-backup-read-state": "denied"
        }
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/services/health"
    ],
    "id": "whm-configuration-health-forwarded",
    "requiredSelectors": [
      "[data-ch-confirm]",
      "[data-ch-fact=\"desired\"]",
      "[data-ch-fact=\"files\"]",
      "[data-ch-fact=\"generation\"]",
      "[data-ch-fact=\"observed\"]",
      "[data-ch-feedback]",
      "[data-ch-reason]",
      "[data-ch-refresh]",
      "[data-ch-repair]",
      "[data-ch-status]",
      "[data-ch-target]",
      "[data-ch-targets]",
      "[data-ch-tests]"
    ],
    "rootSelector": "[data-whm-configuration-health]",
    "elements": [
      {
        "selector": "[data-ch-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ch-target]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ch-confirm]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-ch-repair]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/panel/developer",
      "/advanced/api-shell"
    ],
    "id": "whm-developer-forwarded",
    "requiredSelectors": [
      "[data-dev-copy-status]",
      "[data-dev-copy]",
      "[data-dev-fact=\"method\"]",
      "[data-dev-fact=\"observed\"]",
      "[data-dev-fact=\"path\"]",
      "[data-dev-fact=\"status\"]",
      "[data-dev-form]",
      "[data-dev-operation]",
      "[data-dev-refresh]",
      "[data-dev-result-fields]",
      "[data-dev-run]",
      "[data-dev-status]",
      "[data-dev-token-rows]",
      "[data-dev-token-table]"
    ],
    "rootSelector": "[data-developer-workspace]",
    "variants": [
      {
        "applicableRoutes": [
          "/whm/panel/developer"
        ],
        "id": "whm-developer-forwarded:dispatch:0",
        "requiredSelectors": [],
        "rootAttributes": {
          "data-developer-surface": "administrator"
        },
        "rootRequired": true,
        "rootSelector": "[data-developer-workspace]"
      },
      {
        "applicableRoutes": [
          "/advanced/api-shell"
        ],
        "id": "whm-developer-forwarded:dispatch:1",
        "requiredSelectors": [],
        "rootAttributes": {
          "data-developer-surface": "account"
        },
        "rootRequired": true,
        "rootSelector": "[data-developer-workspace]"
      }
    ],
    "elements": [
      {
        "selector": "[data-dev-form]",
        "tags": [
          "form"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-dev-operation]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-dev-run]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-dev-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-dev-copy]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/dns/more"
    ],
    "id": "whm-dns-tools-forwarded",
    "requiredSelectors": [
      "[data-whm-dns-tools-fact=\"observed-at\"]",
      "[data-whm-dns-tools-fact=\"zones\"]",
      "[data-whm-dns-tools-job-link]",
      "[data-whm-dns-tools-limited]",
      "[data-whm-dns-tools-load]",
      "[data-whm-dns-tools-page-label=\"compare\"]",
      "[data-whm-dns-tools-page-label=\"nameservers\"]",
      "[data-whm-dns-tools-refresh]",
      "[data-whm-dns-tools-result=\"check\"]",
      "[data-whm-dns-tools-result=\"ttl\"]",
      "[data-whm-dns-tools-rows=\"applied\"]",
      "[data-whm-dns-tools-rows=\"compare\"]",
      "[data-whm-dns-tools-rows=\"jobs\"]",
      "[data-whm-dns-tools-rows=\"nameservers\"]",
      "[data-whm-dns-tools-rows=\"preview\"]",
      "[data-whm-dns-tools-rows=\"results\"]",
      "[data-whm-dns-tools-rows=\"zones\"]",
      "[data-whm-dns-tools-run=\"apply\"]",
      "[data-whm-dns-tools-run=\"check\"]",
      "[data-whm-dns-tools-run=\"preview\"]",
      "[data-whm-dns-tools-search]",
      "[data-whm-dns-tools-selected]",
      "[data-whm-dns-tools-status=\"check\"]",
      "[data-whm-dns-tools-status=\"compare\"]",
      "[data-whm-dns-tools-status=\"nameservers\"]",
      "[data-whm-dns-tools-status=\"results\"]",
      "[data-whm-dns-tools-status=\"summary\"]",
      "[data-whm-dns-tools-status=\"ttl\"]",
      "[data-whm-dns-tools-ttl]"
    ],
    "rootSelector": "[data-whm-dns-tools-workspace]",
    "elements": [
      {
        "selector": "[data-whm-dns-tools-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-dns-tools-ttl]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-dns-tools-search]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-dns-tools-job-link]",
        "tags": [
          "a"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ],
    "optionalSelectors": [
      "[data-whm-dns-tools-job]"
    ]
  },
  {
    "applicableRoutes": [
      "/whm/jobs"
    ],
    "id": "whm-jobs-forwarded",
    "requiredSelectors": [
      "[data-whm-jobs-apply]",
      "[data-whm-jobs-cancel-status]",
      "[data-whm-jobs-cancel]",
      "[data-whm-jobs-clear]",
      "[data-whm-jobs-detail-status]",
      "[data-whm-jobs-empty]",
      "[data-whm-jobs-error]",
      "[data-whm-jobs-failure]",
      "[data-whm-jobs-filters]",
      "[data-whm-jobs-kind-filter]",
      "[data-whm-jobs-loading]",
      "[data-whm-jobs-log-more]",
      "[data-whm-jobs-log-status]",
      "[data-whm-jobs-log]",
      "[data-whm-jobs-outcome]",
      "[data-whm-jobs-refresh]",
      "[data-whm-jobs-rows]",
      "[data-whm-jobs-status-filter]",
      "[data-whm-jobs-status]",
      "[data-whm-jobs-steps]",
      "[data-whm-jobs-verification-detail]",
      "[data-whm-jobs-verification]"
    ],
    "rootSelector": "[data-whm-jobs-workspace]",
    "elements": [
      {
        "selector": "[data-whm-jobs-filters]",
        "tags": [
          "form"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-jobs-status-filter]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-jobs-kind-filter]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-jobs-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-jobs-clear]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-jobs-apply]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-jobs-log-more]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-jobs-cancel]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/panel/languages"
    ],
    "id": "whm-languages-forwarded",
    "requiredSelectors": [
      "[data-whm-languages-catalog-status]",
      "[data-whm-languages-default]",
      "[data-whm-languages-download]",
      "[data-whm-languages-errors]",
      "[data-whm-languages-file=\"ar\"]",
      "[data-whm-languages-form]",
      "[data-whm-languages-loading]",
      "[data-whm-languages-messages=\"ar\"]",
      "[data-whm-languages-messages=\"en\"]",
      "[data-whm-languages-offered]",
      "[data-whm-languages-reload]",
      "[data-whm-languages-remove]",
      "[data-whm-languages-save-status]",
      "[data-whm-languages-save]",
      "[data-whm-languages-setting=\"ar\"]",
      "[data-whm-languages-setting=\"en\"]",
      "[data-whm-languages-status]",
      "[data-whm-languages-upload]"
    ],
    "rootSelector": "[data-whm-languages-workspace]",
    "elements": [
      {
        "selector": "[data-whm-languages-form]",
        "tags": [
          "form"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-languages-default]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-languages-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-languages-reload]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-languages-offered]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "every"
      },
      {
        "selector": "[data-whm-languages-download]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "every"
      },
      {
        "selector": "[data-whm-languages-upload]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "every"
      },
      {
        "selector": "[data-whm-languages-remove]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "every"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/email/maintenance"
    ],
    "id": "whm-mailbox-maintenance-forwarded",
    "requiredSelectors": [
      "[data-whm-mailbox-maintenance-fact=\"account\"]",
      "[data-whm-mailbox-maintenance-fact=\"count\"]",
      "[data-whm-mailbox-maintenance-fact=\"fts\"]",
      "[data-whm-mailbox-maintenance-fact=\"jobs\"]",
      "[data-whm-mailbox-maintenance-fact=\"mailbox\"]",
      "[data-whm-mailbox-maintenance-fact=\"messages\"]",
      "[data-whm-mailbox-maintenance-fact=\"observed-at\"]",
      "[data-whm-mailbox-maintenance-fact=\"saved-quota\"]",
      "[data-whm-mailbox-maintenance-fact=\"size\"]",
      "[data-whm-mailbox-maintenance-fact=\"storage\"]",
      "[data-whm-mailbox-maintenance-folders-truncated]",
      "[data-whm-mailbox-maintenance-fts-note]",
      "[data-whm-mailbox-maintenance-job-link]",
      "[data-whm-mailbox-maintenance-limited]",
      "[data-whm-mailbox-maintenance-refresh]",
      "[data-whm-mailbox-maintenance-result]",
      "[data-whm-mailbox-maintenance-rows=\"folders\"]",
      "[data-whm-mailbox-maintenance-rows=\"mailboxes\"]",
      "[data-whm-mailbox-maintenance-rows=\"quota\"]",
      "[data-whm-mailbox-maintenance-search]",
      "[data-whm-mailbox-maintenance-selected]",
      "[data-whm-mailbox-maintenance-status]",
      "[data-whm-mailbox-maintenance-truncated]",
      "[data-whm-mailbox-maintenance-usage-status]"
    ],
    "rootSelector": "[data-whm-mailbox-maintenance-workspace]",
    "elements": [
      {
        "selector": "[data-whm-mailbox-maintenance-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-mailbox-maintenance-search]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-mailbox-maintenance-job-link]",
        "tags": [
          "a"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/panel/branding"
    ],
    "id": "whm-panel-branding-forwarded",
    "requiredSelectors": [
      "[data-branding-asset-state=\"favicon\"]",
      "[data-branding-asset-state=\"logo\"]",
      "[data-branding-asset-status]",
      "[data-branding-file=\"favicon\"]",
      "[data-branding-file=\"logo\"]",
      "[data-branding-input=\"accentColor\"]",
      "[data-branding-input=\"companyName\"]",
      "[data-branding-input=\"defaultDensity\"]",
      "[data-branding-input=\"defaultTheme\"]",
      "[data-branding-input=\"footerText\"]",
      "[data-branding-input=\"hidePoweredBy\"]",
      "[data-branding-input=\"primaryColor\"]",
      "[data-branding-input=\"productName\"]",
      "[data-branding-input=\"supportEmail\"]",
      "[data-branding-input=\"supportUrl\"]",
      "[data-branding-preview=\"favicon\"]",
      "[data-branding-preview=\"logo\"]",
      "[data-branding-reload]",
      "[data-branding-remove=\"favicon\"]",
      "[data-branding-remove=\"logo\"]",
      "[data-branding-save-status]",
      "[data-branding-save]",
      "[data-branding-state]",
      "[data-branding-status]",
      "[data-branding-updated]",
      "[data-branding-upload=\"favicon\"]",
      "[data-branding-upload=\"logo\"]"
    ],
    "rootSelector": "[data-branding-workspace]",
    "elements": [
      {
        "selector": "[data-branding-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-branding-reload]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/panel/notifications"
    ],
    "id": "whm-panel-notifications-forwarded",
    "requiredSelectors": [
      "[data-whm-notifications-form]",
      "[data-whm-notifications-key-status]",
      "[data-whm-notifications-key]",
      "[data-whm-notifications-loading]",
      "[data-whm-notifications-recipients]",
      "[data-whm-notifications-reload]",
      "[data-whm-notifications-save-status]",
      "[data-whm-notifications-save]",
      "[data-whm-notifications-status]",
      "[data-whm-notifications-test-status]",
      "[data-whm-notifications-test]",
      "[data-whm-notifications-webhook-enabled]",
      "[data-whm-notifications-webhook-url]"
    ],
    "rootSelector": "[data-whm-panel-notifications-workspace]",
    "elements": [
      {
        "selector": "[data-whm-notifications-form]",
        "tags": [
          "form"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-notifications-recipients]",
        "tags": [
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-notifications-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-notifications-reload]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-notifications-test]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-notifications-webhook-enabled]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-notifications-webhook-url]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-notifications-key]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/panel/settings"
    ],
    "id": "whm-panel-settings-forwarded",
    "requiredSelectors": [
      "[data-panel-settings-input=\"developerMode\"]",
      "[data-panel-settings-input=\"liveUpdates\"]",
      "[data-panel-settings-input=\"offlineMessage\"]",
      "[data-panel-settings-input=\"offlineMode\"]",
      "[data-panel-settings-input=\"reverseProxyAllowedHosts\"]",
      "[data-panel-settings-reload]",
      "[data-panel-settings-save-status]",
      "[data-panel-settings-save]",
      "[data-panel-settings-status]",
      "[data-panel-settings-updated]"
    ],
    "rootSelector": "[data-panel-settings-workspace]",
    "elements": [
      {
        "selector": "[data-panel-settings-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-panel-settings-reload]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/panel/api-tokens"
    ],
    "id": "whm-panel-tokens-forwarded",
    "requiredSelectors": [
      "[data-whm-tokens-all]",
      "[data-whm-tokens-clear]",
      "[data-whm-tokens-copy-status]",
      "[data-whm-tokens-copy]",
      "[data-whm-tokens-create-status]",
      "[data-whm-tokens-create-submit]",
      "[data-whm-tokens-create]",
      "[data-whm-tokens-done]",
      "[data-whm-tokens-empty]",
      "[data-whm-tokens-expiry]",
      "[data-whm-tokens-ips]",
      "[data-whm-tokens-loading]",
      "[data-whm-tokens-name]",
      "[data-whm-tokens-refresh]",
      "[data-whm-tokens-reveal-text]",
      "[data-whm-tokens-reveal]",
      "[data-whm-tokens-revoke-status]",
      "[data-whm-tokens-rows]",
      "[data-whm-tokens-secret]",
      "[data-whm-tokens-status]"
    ],
    "rootSelector": "[data-whm-panel-tokens-workspace]",
    "elements": [
      {
        "selector": "[data-whm-tokens-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-tokens-copy]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-tokens-done]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-tokens-create]",
        "tags": [
          "form"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-tokens-name]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-tokens-expiry]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-tokens-ips]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-tokens-all]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-tokens-create-submit]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-tokens-clear]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/preferences"
    ],
    "id": "whm-preferences-forwarded",
    "requiredSelectors": [
      "[data-whm-preferences-apply]",
      "[data-whm-preferences-field=\"density\"]",
      "[data-whm-preferences-field=\"language\"]",
      "[data-whm-preferences-field=\"theme\"]",
      "[data-whm-preferences-field=\"updatedAt\"]",
      "[data-whm-preferences-form]",
      "[data-whm-preferences-input=\"density\"]",
      "[data-whm-preferences-input=\"language\"]",
      "[data-whm-preferences-input=\"theme\"]",
      "[data-whm-preferences-loading]",
      "[data-whm-preferences-reload]",
      "[data-whm-preferences-save-status]",
      "[data-whm-preferences-save]",
      "[data-whm-preferences-status]"
    ],
    "rootSelector": "[data-whm-preferences-workspace]",
    "elements": [
      {
        "selector": "[data-whm-preferences-form]",
        "tags": [
          "form"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-preferences-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-preferences-reload]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-preferences-apply]",
        "tags": [
          "a"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-preferences-input=\"language\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-preferences-input=\"theme\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-preferences-input=\"density\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/security/intrusion"
    ],
    "id": "security-tools-intrusion",
    "requiredSelectors": [
      "[data-whm-security-tools-fact=\"banned\"]",
      "[data-whm-security-tools-fact=\"jails\"]",
      "[data-whm-security-tools-fact=\"observed-at\"]",
      "[data-whm-security-tools-fact=\"service\"]",
      "[data-whm-security-tools-filter=\"jail\"]",
      "[data-whm-security-tools-filter=\"text\"]",
      "[data-whm-security-tools-install]",
      "[data-whm-security-tools-refresh]",
      "[data-whm-security-tools-result]",
      "[data-whm-security-tools-rows=\"banned\"]",
      "[data-whm-security-tools-rows=\"jails\"]",
      "[data-whm-security-tools-status]",
      "[data-whm-security-tools-truncated]",
      "[data-whm-security-tools-unsupported]"
    ],
    "rootAttributes": {
      "data-security-tools-page": "intrusion"
    },
    "rootSelector": "[data-whm-security-tools-workspace]",
    "elements": [
      {
        "selector": "[data-whm-security-tools-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-security-tools-filter=\"jail\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-security-tools-filter=\"text\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/security/antivirus"
    ],
    "id": "security-tools-antivirus",
    "requiredSelectors": [
      "[data-whm-security-tools-account]",
      "[data-whm-security-tools-fact=\"engine\"]",
      "[data-whm-security-tools-fact=\"observed-at\"]",
      "[data-whm-security-tools-fact=\"signature-date\"]",
      "[data-whm-security-tools-fact=\"signatures\"]",
      "[data-whm-security-tools-fact=\"updater\"]",
      "[data-whm-security-tools-incomplete]",
      "[data-whm-security-tools-install]",
      "[data-whm-security-tools-job-link]",
      "[data-whm-security-tools-refresh]",
      "[data-whm-security-tools-result]",
      "[data-whm-security-tools-rows=\"findings\"]",
      "[data-whm-security-tools-rows=\"scans\"]",
      "[data-whm-security-tools-rows=\"updates\"]",
      "[data-whm-security-tools-scan]",
      "[data-whm-security-tools-status]",
      "[data-whm-security-tools-update]"
    ],
    "rootAttributes": {
      "data-security-tools-page": "antivirus"
    },
    "rootSelector": "[data-whm-security-tools-workspace]",
    "elements": [
      {
        "selector": "[data-whm-security-tools-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-security-tools-account]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-security-tools-scan]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-security-tools-update]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-security-tools-job-link]",
        "tags": [
          "a"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/security/isolation"
    ],
    "id": "security-tools-isolation",
    "requiredSelectors": [
      "[data-whm-security-tools-account]",
      "[data-whm-security-tools-drift]",
      "[data-whm-security-tools-fact=\"account\"]",
      "[data-whm-security-tools-fact=\"account-status\"]",
      "[data-whm-security-tools-fact=\"observed-at\"]",
      "[data-whm-security-tools-fact=\"state\"]",
      "[data-whm-security-tools-fact=\"uid\"]",
      "[data-whm-security-tools-inspect]",
      "[data-whm-security-tools-refresh]",
      "[data-whm-security-tools-rows=\"checks\"]",
      "[data-whm-security-tools-status]"
    ],
    "rootAttributes": {
      "data-security-tools-page": "isolation"
    },
    "rootSelector": "[data-whm-security-tools-workspace]",
    "elements": [
      {
        "selector": "[data-whm-security-tools-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-security-tools-account]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-security-tools-inspect]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ],
    "optionalSelectors": [
      "[data-whm-security-tools-result]"
    ]
  },
  {
    "applicableRoutes": [
      "/whm/services/more"
    ],
    "id": "whm-service-manager-forwarded",
    "requiredSelectors": [
      "[data-sm-confirm]",
      "[data-sm-fact=\"active\"]",
      "[data-sm-fact=\"boot-time\"]",
      "[data-sm-fact=\"observed-at\"]",
      "[data-sm-fact=\"services\"]",
      "[data-sm-filter]",
      "[data-sm-job-link]",
      "[data-sm-job]",
      "[data-sm-reboot]",
      "[data-sm-refresh]",
      "[data-sm-result]",
      "[data-sm-rows]",
      "[data-sm-search]",
      "[data-sm-status]"
    ],
    "rootSelector": "[data-whm-service-manager]",
    "elements": [
      {
        "selector": "[data-sm-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sm-search]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sm-filter]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sm-confirm]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sm-reboot]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sm-job-link]",
        "tags": [
          "a"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/software/catalog",
      "/whm/software/modules",
      "/whm/software/runtimes"
    ],
    "id": "whm-software-center-forwarded",
    "requiredSelectors": [
      "[data-sc-accept-extra]",
      "[data-sc-cancel]",
      "[data-sc-category]",
      "[data-sc-confirm]",
      "[data-sc-family]",
      "[data-sc-groups]",
      "[data-sc-job-link]",
      "[data-sc-job]",
      "[data-sc-observed-at]",
      "[data-sc-preview-disk]",
      "[data-sc-preview-download]",
      "[data-sc-preview-extra-list]",
      "[data-sc-preview-extra]",
      "[data-sc-preview-install]",
      "[data-sc-preview-memory]",
      "[data-sc-preview-remove]",
      "[data-sc-preview-size]",
      "[data-sc-preview-summary]",
      "[data-sc-preview-upgrade]",
      "[data-sc-preview]",
      "[data-sc-refresh]",
      "[data-sc-search]",
      "[data-sc-status]"
    ],
    "rootSelector": "[data-whm-software-center]",
    "variants": [
      {
        "applicableRoutes": [
          "/whm/software/catalog"
        ],
        "id": "whm-software-center-forwarded:dispatch:0",
        "requiredSelectors": [],
        "rootAttributes": {
          "data-sc-page": "catalog"
        },
        "rootRequired": true,
        "rootSelector": "[data-whm-software-center]"
      },
      {
        "applicableRoutes": [
          "/whm/software/modules"
        ],
        "id": "whm-software-center-forwarded:dispatch:1",
        "requiredSelectors": [],
        "rootAttributes": {
          "data-sc-page": "module"
        },
        "rootRequired": true,
        "rootSelector": "[data-whm-software-center]"
      },
      {
        "applicableRoutes": [
          "/whm/software/runtimes"
        ],
        "id": "whm-software-center-forwarded:dispatch:2",
        "requiredSelectors": [],
        "rootAttributes": {
          "data-sc-page": "runtime"
        },
        "rootRequired": true,
        "rootSelector": "[data-whm-software-center]"
      }
    ],
    "elements": [
      {
        "selector": "[data-sc-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sc-category]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sc-search]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sc-confirm]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sc-cancel]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sc-accept-extra]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-sc-job-link]",
        "tags": [
          "a"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ],
    "conditionalRequired": [
      {
        "rootAttributes": {
          "data-sc-page": "module"
        },
        "requiredSelectors": [
          "[data-sc-php-versions]"
        ]
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/ssl"
    ],
    "id": "whm-ssl-observations-forwarded",
    "requiredSelectors": [
      "[data-ssl-management-status]",
      "[data-ssl-order-log-status]",
      "[data-ssl-queue-status]"
    ],
    "rootSelector": "[data-whm-ssl]",
    "lookupScope": {
      "kind": "closest",
      "selector": "[data-whm-detail-route=\"/whm/ssl\"]"
    }
  },
  {
    "applicableRoutes": [
      "/whm/support"
    ],
    "id": "whm-support-forwarded",
    "requiredSelectors": [
      "[data-whm-support-bundle-status]",
      "[data-whm-support-confirm]",
      "[data-whm-support-contact]",
      "[data-whm-support-download]",
      "[data-whm-support-hashing]",
      "[data-whm-support-refresh]",
      "[data-whm-support-status]"
    ],
    "rootSelector": "[data-whm-support-workspace]",
    "elements": [
      {
        "selector": "[data-whm-support-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-support-confirm]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-support-download]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/server/trusted-proxies"
    ],
    "id": "whm-trusted-proxies-forwarded",
    "requiredSelectors": [
      "[data-trusted-proxies-apply-status]",
      "[data-trusted-proxies-apply]",
      "[data-trusted-proxies-cidrs]",
      "[data-trusted-proxies-confirm]",
      "[data-trusted-proxies-field=\"activation\"]",
      "[data-trusted-proxies-field=\"active\"]",
      "[data-trusted-proxies-field=\"saved\"]",
      "[data-trusted-proxies-field=\"updated\"]",
      "[data-trusted-proxies-form]",
      "[data-trusted-proxies-reload]",
      "[data-trusted-proxies-rows]",
      "[data-trusted-proxies-save-status]",
      "[data-trusted-proxies-save]",
      "[data-trusted-proxies-status]"
    ],
    "rootSelector": "[data-whm-trusted-proxies-workspace]",
    "elements": [
      {
        "selector": "[data-trusted-proxies-form]",
        "tags": [
          "form"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-trusted-proxies-cidrs]",
        "tags": [
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-trusted-proxies-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-trusted-proxies-reload]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-trusted-proxies-apply]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-trusted-proxies-confirm]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-trusted-proxies-rows]",
        "tags": [
          "tbody",
          "tfoot",
          "thead"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/server/upgrade"
    ],
    "id": "whm-upgrade-forwarded",
    "requiredSelectors": [
      "[data-upgrade-banner]",
      "[data-upgrade-cancel]",
      "[data-upgrade-confirm-input]",
      "[data-upgrade-confirm]",
      "[data-upgrade-fact=\"added-release\"]",
      "[data-upgrade-fact=\"added-schema\"]",
      "[data-upgrade-fact=\"available-bytes\"]",
      "[data-upgrade-fact=\"available-schema\"]",
      "[data-upgrade-fact=\"available-signature\"]",
      "[data-upgrade-fact=\"available-version\"]",
      "[data-upgrade-fact=\"confirm-from\"]",
      "[data-upgrade-fact=\"confirm-phrase\"]",
      "[data-upgrade-fact=\"confirm-to\"]",
      "[data-upgrade-fact=\"coordinator\"]",
      "[data-upgrade-fact=\"current-path\"]",
      "[data-upgrade-fact=\"current-schema\"]",
      "[data-upgrade-fact=\"current-since\"]",
      "[data-upgrade-fact=\"current-version\"]",
      "[data-upgrade-fact=\"snapshot-dir\"]",
      "[data-upgrade-fact=\"staged-directory\"]",
      "[data-upgrade-fact=\"trust-keys\"]",
      "[data-upgrade-fact=\"trust-source\"]",
      "[data-upgrade-history]",
      "[data-upgrade-migrations]",
      "[data-upgrade-open-confirm]",
      "[data-upgrade-preflight-summary]",
      "[data-upgrade-preflight]",
      "[data-upgrade-progress]",
      "[data-upgrade-refresh]",
      "[data-upgrade-staged]",
      "[data-upgrade-start]",
      "[data-upgrade-status]",
      "[data-upgrade-target]"
    ],
    "rootSelector": "[data-whm-upgrade-workspace]",
    "lookupScope": {
      "kind": "closest",
      "selector": "[data-whm-detail-route=\"/whm/server/upgrade\"]"
    },
    "elements": [
      {
        "selector": "[data-upgrade-target]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-upgrade-confirm]",
        "tags": [
          "details"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-upgrade-confirm-input]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-upgrade-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-upgrade-preflight]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-upgrade-open-confirm]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-upgrade-cancel]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-upgrade-start]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/panel/whmcs"
    ],
    "id": "whm-whmcs-forwarded",
    "requiredSelectors": [
      "[data-whm-whmcs-copy-status]",
      "[data-whm-whmcs-copy]",
      "[data-whm-whmcs-done]",
      "[data-whm-whmcs-download-status]",
      "[data-whm-whmcs-download]",
      "[data-whm-whmcs-form]",
      "[data-whm-whmcs-identifier]",
      "[data-whm-whmcs-input=\"allowedAddresses\"]",
      "[data-whm-whmcs-input=\"autoCreate\"]",
      "[data-whm-whmcs-input=\"enabled\"]",
      "[data-whm-whmcs-input=\"ssoTarget\"]",
      "[data-whm-whmcs-input=\"whmcsUrl\"]",
      "[data-whm-whmcs-loading]",
      "[data-whm-whmcs-log-refresh]",
      "[data-whm-whmcs-log-rows]",
      "[data-whm-whmcs-log-status]",
      "[data-whm-whmcs-plan-add]",
      "[data-whm-whmcs-plan-rows]",
      "[data-whm-whmcs-reload]",
      "[data-whm-whmcs-reveal]",
      "[data-whm-whmcs-rotate]",
      "[data-whm-whmcs-save-status]",
      "[data-whm-whmcs-save]",
      "[data-whm-whmcs-secret]",
      "[data-whm-whmcs-status]",
      "[data-whm-whmcs-token-created]",
      "[data-whm-whmcs-token-status]",
      "[data-whm-whmcs-token]",
      "[data-whm-whmcs-updated]"
    ],
    "rootSelector": "[data-whm-whmcs-workspace]",
    "elements": [
      {
        "selector": "[data-whm-whmcs-form]",
        "tags": [
          "form"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-save]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-reload]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-input=\"enabled\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-input=\"whmcsUrl\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-input=\"allowedAddresses\"]",
        "tags": [
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-input=\"ssoTarget\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-input=\"autoCreate\"]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-identifier]",
        "tags": [
          "input"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-plan-add]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-download]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-rotate]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-copy]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-done]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      },
      {
        "selector": "[data-whm-whmcs-log-refresh]",
        "tags": [
          "button"
        ],
        "attributes": {},
        "occurrence": "first"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/whm/accounts/new"
    ],
    "id": "create-account-plan-preview",
    "optionalSelectors": [],
    "parentRootSelector": "form[data-create-account-form]",
    "requiredSelectors": [
      "[data-plan-preview-model]",
      "[data-preview-plan-name]",
      "[data-preview-plan-disk]",
      "[data-preview-plan-memory]",
      "[data-preview-plan-cpu]",
      "[data-preview-plan-capacity]"
    ],
    "rootSelector": "[data-create-plan-preview]"
  },
  {
    "applicableRoutes": [
      "/whm/domains"
    ],
    "id": "approved-whm-domain-table-filters",
    "optionalSelectors": [
      "[name=\"whm-search\"]",
      "[name=\"whm-account\"]",
      "[name=\"whm-ssl\"]",
      "[name=\"whm-php\"]",
      "[name=\"whm-status\"]",
      "[name=\"whm-page-size\"]",
      "[data-whm-page=\"previous\"]",
      "[data-whm-page=\"next\"]",
      "[data-whm-page-status]",
      "button[data-whm-kind]"
    ],
    "ownScopeOnly": true,
    "requiredSelectors": [
      "[data-whm-filter-table]"
    ],
    "rootSelector": "[data-whm-table-workspace]"
  },
  {
    "applicableRoutes": [
      "/mail/compose"
    ],
    "id": "mail-compose-recipient-controls",
    "nestedScopes": [
      {
        "requiredSelectors": [
          "ul",
          "[data-mail-recip-input=\"to\"]"
        ],
        "rootSelector": "[data-mail-recip=\"to\"]",
        "id": "mail-compose-recipient-controls:nestedScopes:0",
        "rootRequired": false
      },
      {
        "requiredSelectors": [
          "ul",
          "[data-mail-recip-input=\"cc\"]"
        ],
        "rootSelector": "[data-mail-recip=\"cc\"]",
        "id": "mail-compose-recipient-controls:nestedScopes:1",
        "rootRequired": false
      },
      {
        "requiredSelectors": [
          "ul",
          "[data-mail-recip-input=\"bcc\"]"
        ],
        "rootSelector": "[data-mail-recip=\"bcc\"]",
        "id": "mail-compose-recipient-controls:nestedScopes:2",
        "rootRequired": false
      }
    ],
    "optionalSelectors": [],
    "requiredSelectors": [
      "[data-mail-recip=\"to\"]",
      "[data-mail-recip-input=\"to\"]",
      "#compose-to",
      "[data-mail-recip=\"cc\"]",
      "[data-mail-recip-input=\"cc\"]",
      "#compose-cc",
      "[data-mail-recip=\"bcc\"]",
      "[data-mail-recip-input=\"bcc\"]",
      "#compose-bcc"
    ],
    "rootSelector": "[data-board-port=\"xmail-compose\"]",
    "variants": []
  },
  {
    "applicableRoutes": [
      "/mail/inbox",
      "/mail/sent",
      "/mail/drafts",
      "/mail/trash"
    ],
    "id": "mail-inbox-reading-projections",
    "keyedTargets": [
      {
        "fromSelector": "[data-mail-open]",
        "fromAttribute": "data-mail-open",
        "templateSelector": "#xmail-reading",
        "targetSelector": "[data-reading-id]",
        "targetAttribute": "data-reading-id"
      }
    ],
    "optionalSelectors": [
      "[data-mail-count]"
    ],
    "requiredSelectors": [
      "#xmail-reading",
      "#xmail-empty",
      "[data-mail-list]",
      "[data-mail-article]"
    ],
    "rootSelector": "[data-board-port=\"xmail-inbox\"]",
    "templateScopes": [
      {
        "perItemSelector": "[data-reading-id]",
        "requiredSelectors": [
          "[data-mail-detail-subject]",
          "[data-mail-detail-name]",
          "[data-mail-detail-from]",
          "[data-mail-detail-to]",
          "[data-mail-detail-cc]",
          "[data-mail-detail-avatar]",
          "[data-mail-detail-date]"
        ],
        "templateSelector": "#xmail-reading"
      }
    ]
  },
  {
    "applicableRoutes": [
      "/home"
    ],
    "id": "panel-home-desktop-filter",
    "optionalSelectors": [
      "#tool-filter-count",
      "#home-header-search"
    ],
    "requiredSelectors": [
      "#tool-filter"
    ],
    "rootSelector": "[data-home-desktop]"
  },
  {
    "applicableRoutes": [
      "/home"
    ],
    "id": "panel-home-phone-filter",
    "optionalSelectors": [
      "#m-filter-count"
    ],
    "requiredSelectors": [
      "#m-filter"
    ],
    "rootSelector": "[data-home-phone]"
  },
  {
    "applicableRoutes": [
      "/home"
    ],
    "id": "home-desktop-filter-ids",
    "relations": [
      {
        "guardRequired": true,
        "targetId": "tool-filter",
        "targetTag": "input"
      },
      {
        "capabilityRequired": true,
        "guardRequired": false,
        "targetId": "tool-filter-count"
      },
      {
        "guardRequired": false,
        "targetId": "home-header-search",
        "targetTag": "input"
      }
    ],
    "requiredSelectors": [],
    "rootSelector": "[data-home-desktop]",
    "lookupScope": {
      "kind": "document"
    }
  },
  {
    "applicableRoutes": [
      "/home"
    ],
    "id": "home-phone-filter-ids",
    "relations": [
      {
        "guardRequired": true,
        "targetId": "m-filter",
        "targetTag": "input"
      },
      {
        "capabilityRequired": true,
        "guardRequired": false,
        "targetId": "m-filter-count"
      }
    ],
    "requiredSelectors": [],
    "rootSelector": "[data-home-phone]",
    "lookupScope": {
      "kind": "document"
    }
  },
  {
    "applicableRoutes": [
      "/home"
    ],
    "id": "home-group-controls-relation",
    "relations": [
      {
        "idAttribute": "aria-controls",
        "ownerSelector": "[data-home-action=\"toggle-group\"]",
        "sameRoot": "[data-home-phone]",
        "targetHook": "[data-tool-panel]",
        "targetIdPattern": "^m-group-tools-[0-9]+$",
        "targetMustBeUnique": true,
        "targetTag": "ul"
      }
    ],
    "requiredSelectors": [],
    "rootSelector": "[data-home-phone]",
    "lookupScope": {
      "kind": "document"
    }
  },
  {
    "applicableRoutes": [],
    "id": "login-password-toggle-target",
    "relations": [
      {
        "finiteTargetIds": [
          "login-password"
        ],
        "idAttribute": "data-target",
        "ownerSelector": "[data-action=\"toggle-password\"]",
        "sameForm": "[data-login-form]",
        "sameIdAttributes": [
          "aria-controls"
        ],
        "targetMustBeUnique": true,
        "targetName": "password",
        "targetTag": "input",
        "targetTypes": [
          "password",
          "text"
        ]
      }
    ],
    "requiredSelectors": [],
    "rootSelector": "document",
    "routeScope": {
      "kind": "login-surface",
      "audiences": [
        "xpanel",
        "xwhm",
        "xmail"
      ]
    },
    "lookupScope": {
      "kind": "document"
    }
  },
  {
    "applicableRoutes": [
      "/mail/compose"
    ],
    "associatedEditor": {
      "id": "compose-body",
      "allowedKinds": [
        {
          "tag": "textarea"
        },
        {
          "tag": "input"
        },
        {
          "contenteditable": "true",
          "role": "textbox"
        }
      ]
    },
    "id": "compose-recipient-input-ids",
    "relations": [
      {
        "finiteValues": [
          "to",
          "cc",
          "bcc"
        ],
        "sourceValue": "kind",
        "targetIdTemplate": "compose-${kind}",
        "targetMustBeUnique": true,
        "targetTag": "input"
      }
    ],
    "requiredSelectors": [],
    "rootSelector": "[data-mail-send=\"true\"]",
    "lookupScope": {
      "kind": "document"
    }
  },
  {
    "applicableRoutes": [
      "/mail/compose"
    ],
    "id": "compose-clear-accepted-input-ids",
    "relations": [
      {
        "optionalLookup": true,
        "targetIds": [
          "compose-to",
          "compose-cc",
          "compose-bcc",
          "compose-subject"
        ],
        "targetTag": "input"
      }
    ],
    "requiredSelectors": [],
    "rootSelector": "[data-mail-send=\"true\"]",
    "lookupScope": {
      "kind": "document"
    }
  },
  {
    "applicableRoutes": [
      "/email/calendars-contacts"
    ],
    "id": "handoff-mailbox-select-id",
    "relations": [
      {
        "idAttribute": "data-handoff-mailbox-select",
        "ownerSelector": "button[data-handoff][data-handoff-mailbox-select]",
        "sameRoot": "[data-account-collaboration]",
        "targetMustBeUnique": true,
        "targetTag": "select"
      }
    ],
    "requiredSelectors": [],
    "rootSelector": "[data-account-collaboration]",
    "lookupScope": {
      "kind": "document"
    }
  },
  {
    "applicableRoutes": [
      "/whm/accounts/new"
    ],
    "id": "account-password-reveal-target",
    "relations": [
      {
        "idAttribute": "data-password-target",
        "ownerSelector": "[data-account-toggle-password]",
        "sameOwningForm": "[data-create-account-form]",
        "targetAutocomplete": "new-password",
        "targetMustBeUnique": true,
        "targetName": "password",
        "targetTag": "input",
        "targetTypes": [
          "password",
          "text"
        ]
      }
    ],
    "requiredSelectors": [],
    "rootSelector": "document",
    "lookupScope": {
      "kind": "document"
    }
  },
  {
    "applicableRoutes": [
      "/whm/accounts/new",
      "/email/accounts"
    ],
    "id": "generated-password-target",
    "relations": [
      {
        "idAttribute": "data-password-target",
        "ownerSelector": "[data-password-generate],[data-account-generate-password]",
        "sameOwningForm": {
          "data-account-generate-password": "[data-create-account-form]",
          "data-password-generate": "[data-mailbox-form]"
        },
        "targetAutocomplete": "new-password",
        "targetMustBeUnique": true,
        "targetName": "password",
        "targetTag": "input",
        "targetTypes": [
          "password",
          "text"
        ]
      }
    ],
    "requiredSelectors": [],
    "rootSelector": "document",
    "lookupScope": {
      "kind": "document"
    }
  },
  {
    "applicableRoutes": [],
    "id": "shared-focus-selector-match",
    "requiredSelectors": [],
    "rootSelector": "document",
    "routeScope": {
      "kind": "non-login-non-error-documents",
      "surfaces": [
        "xwhm",
        "xpanel",
        "xmail"
      ]
    },
    "lookupScope": {
      "kind": "document"
    },
    "qualifiedOnly": false
  },
  {
    "applicableRoutes": [],
    "id": "shared-hash-navigation-id",
    "requiredSelectors": [],
    "rootSelector": "document",
    "routeScope": {
      "kind": "non-login-non-error-documents",
      "surfaces": [
        "xwhm",
        "xpanel",
        "xmail"
      ]
    },
    "lookupScope": {
      "kind": "document"
    },
    "qualifiedOnly": false
  },
  {
    "applicableRoutes": [
      "/domains/reverse-proxy"
    ],
    "id": "account-reverse-proxy",
    "requiredSelectors": [
      "[data-rp-status]",
      "[data-rp-rows]",
      "[data-rp-application]",
      "[data-rp-refresh]",
      "[data-rp-mode]",
      "[data-rp-upstream]",
      "[data-rp-upstream-field]",
      "[data-rp-error]",
      "[data-rp-save]",
      "[data-rp-cancel]",
      "[data-rp-selected]",
      "[data-rp-current]",
      "[data-rp-root]",
      "[data-rp-options]",
      "[data-rp-websocket]",
      "[data-rp-host]",
      "[data-rp-header-rows]",
      "[data-rp-add-header]",
      "[data-rp-headers-error]"
    ],
    "rootSelector": "[data-reverse-proxy]"
  },
  {
    "applicableRoutes": [
      "/email/forwarders"
    ],
    "optionalSelectors": [
      "[data-autoresponder-status]"
    ],
    "rootSelector": "[data-autoresponder-workspace]",
    "id": "account-forwarders:variants:1",
    "requiredSelectors": [
      "[data-autoresponder-rows]"
    ],
    "elements": [
      {
        "selector": "[data-autoresponder-rows]",
        "tags": [
          "tbody",
          "thead",
          "tfoot"
        ],
        "occurrence": "first"
      },
      {
        "selector": "[data-autoresponder-form]",
        "tags": [
          "form"
        ],
        "occurrence": "first",
        "required": false
      }
    ],
    "variants": [],
    "conditionalRequirements": [],
    "conditionalRequired": [
      {
        "id": "account-forwarders:variants:1:domain-write-form",
        "rootAttributes": {
          "data-autoresponder-manage": "true"
        },
        "contextFacts": {
          "account-domains": "present"
        },
        "requiredSelectors": [
          "[data-autoresponder-form]"
        ],
        "elements": [
          {
            "selector": "[data-autoresponder-form]",
            "tags": [
              "form"
            ],
            "occurrence": "first"
          }
        ]
      }
    ],
    "nestedScopes": [
      {
        "id": "autoresponder-edit-named-controls",
        "rootSelector": "[data-autoresponder-form]",
        "rootRequired": false,
        "requiredSelectors": [
          "[name=\"address\"],[id=\"address\"]",
          "[name=\"subject\"],[id=\"subject\"]",
          "[name=\"body\"],[id=\"body\"]",
          "[name=\"interval\"],[id=\"interval\"]",
          "[name=\"start\"],[id=\"start\"]",
          "[name=\"end\"],[id=\"end\"]",
          "[name=\"noEnd\"],[id=\"noEnd\"]",
          "[data-autoresponder-form-title]",
          "[data-autoresponder-submit]",
          "[data-autoresponder-cancel]"
        ],
        "elements": [
          {
            "selector": "[name=\"address\"],[id=\"address\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "email",
              "dir": "ltr",
              "maxlength": "254"
            }
          },
          {
            "selector": "[name=\"subject\"],[id=\"subject\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first",
            "attributes": {
              "maxlength": "256"
            }
          },
          {
            "selector": "[name=\"body\"],[id=\"body\"]",
            "tags": [
              "textarea"
            ],
            "occurrence": "first",
            "attributes": {
              "maxlength": "65536",
              "rows": "4"
            }
          },
          {
            "selector": "[name=\"interval\"],[id=\"interval\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "number",
              "dir": "ltr",
              "min": "1",
              "max": "8760",
              "step": "1"
            }
          },
          {
            "selector": "[name=\"start\"],[id=\"start\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "datetime-local",
              "dir": "ltr",
              "step": "60"
            }
          },
          {
            "selector": "[name=\"end\"],[id=\"end\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "datetime-local",
              "dir": "ltr",
              "step": "60"
            }
          },
          {
            "selector": "[name=\"noEnd\"],[id=\"noEnd\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "checkbox"
            }
          }
        ],
        "variants": [
          {
            "id": "autoresponder-edit-named-controls:named-control:0",
            "rootSelector": "[data-autoresponder-form]",
            "rootRequired": true,
            "scopeSelector": "[name=\"address\"],[id=\"address\"]",
            "scopeCount": 1
          },
          {
            "id": "autoresponder-edit-named-controls:named-control:1",
            "rootSelector": "[data-autoresponder-form]",
            "rootRequired": true,
            "scopeSelector": "[name=\"subject\"],[id=\"subject\"]",
            "scopeCount": 1
          },
          {
            "id": "autoresponder-edit-named-controls:named-control:2",
            "rootSelector": "[data-autoresponder-form]",
            "rootRequired": true,
            "scopeSelector": "[name=\"body\"],[id=\"body\"]",
            "scopeCount": 1
          },
          {
            "id": "autoresponder-edit-named-controls:named-control:3",
            "rootSelector": "[data-autoresponder-form]",
            "rootRequired": true,
            "scopeSelector": "[name=\"interval\"],[id=\"interval\"]",
            "scopeCount": 1
          },
          {
            "id": "autoresponder-edit-named-controls:named-control:4",
            "rootSelector": "[data-autoresponder-form]",
            "rootRequired": true,
            "scopeSelector": "[name=\"start\"],[id=\"start\"]",
            "scopeCount": 1
          },
          {
            "id": "autoresponder-edit-named-controls:named-control:5",
            "rootSelector": "[data-autoresponder-form]",
            "rootRequired": true,
            "scopeSelector": "[name=\"end\"],[id=\"end\"]",
            "scopeCount": 1
          },
          {
            "id": "autoresponder-edit-named-controls:named-control:6",
            "rootSelector": "[data-autoresponder-form]",
            "rootRequired": true,
            "scopeSelector": "[name=\"noEnd\"],[id=\"noEnd\"]",
            "scopeCount": 1
          }
        ]
      }
    ]
  },
  {
    "applicableRoutes": [
      "/email/forwarders"
    ],
    "optionalSelectors": [
      "[data-default-status]"
    ],
    "rootSelector": "[data-default-workspace]",
    "id": "account-forwarders:variants:2",
    "nestedScopes": [
      {
        "optionalSelectors": [
          "input[name=\"default-kind\"][value=\"reject\"]",
          "input[name=\"default-kind\"][value=\"forward\"]",
          "input[name=\"default-kind\"][value=\"discard\"]",
          "[data-default-destination-field]"
        ],
        "rootSelector": "[data-default-form]",
        "id": "account-forwarders:nestedScopes:0",
        "rootRequired": false,
        "elements": [
          {
            "selector": "input[name=\"default-kind\"][value=\"reject\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first",
            "required": false
          },
          {
            "selector": "input[name=\"default-kind\"][value=\"forward\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first",
            "required": false
          },
          {
            "selector": "input[name=\"default-kind\"][value=\"discard\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first",
            "required": false
          },
          {
            "selector": "[name=\"domain\"],[id=\"domain\"]",
            "tags": [
              "select"
            ],
            "occurrence": "first",
            "attributes": {
              "dir": "ltr"
            }
          },
          {
            "selector": "[name=\"destination\"],[id=\"destination\"]",
            "tags": [
              "input"
            ],
            "occurrence": "first",
            "attributes": {
              "type": "email",
              "dir": "ltr"
            }
          }
        ],
        "requiredSelectors": [
          "[name=\"domain\"],[id=\"domain\"]",
          "[name=\"destination\"],[id=\"destination\"]"
        ],
        "variants": [
          {
            "id": "account-forwarders:nestedScopes:0:named-control:0",
            "rootSelector": "[data-default-form]",
            "rootRequired": true,
            "scopeSelector": "[name=\"domain\"],[id=\"domain\"]",
            "scopeCount": 1
          },
          {
            "id": "account-forwarders:nestedScopes:0:named-control:1",
            "rootSelector": "[data-default-form]",
            "rootRequired": true,
            "scopeSelector": "[name=\"destination\"],[id=\"destination\"]",
            "scopeCount": 1
          }
        ]
      }
    ],
    "elements": [
      {
        "selector": "[data-default-form]",
        "tags": [
          "form"
        ],
        "occurrence": "first",
        "required": false
      }
    ],
    "conditionalRequired": [
      {
        "id": "account-forwarders:variants:2:domain-write-form",
        "rootAttributes": {
          "data-default-manage": "true"
        },
        "contextFacts": {
          "account-domains": "present"
        },
        "requiredSelectors": [
          "[data-default-form]"
        ],
        "elements": [
          {
            "selector": "[data-default-form]",
            "tags": [
              "form"
            ],
            "occurrence": "first"
          }
        ]
      }
    ]
  },
  {
    "id": "account-web-field-controls:error-pages",
    "rootSelector": "[data-web-directives=\"error-pages\"]",
    "rootRequired": true,
    "applicableRoutes": [
      "/advanced/error-pages"
    ],
    "requiredSelectors": [
      "[data-wd-field=\"code\"]",
      "[data-wd-field=\"path\"]"
    ],
    "elements": [
      {
        "selector": "[data-wd-field=\"code\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first",
        "required": true
      },
      {
        "selector": "[data-wd-field=\"path\"]",
        "tags": [
          "input"
        ],
        "attributes": {
          "type": "text"
        },
        "occurrence": "first",
        "required": true
      }
    ]
  },
  {
    "id": "account-web-field-controls:indexes",
    "rootSelector": "[data-web-directives=\"indexes\"]",
    "rootRequired": true,
    "applicableRoutes": [
      "/advanced/indexes"
    ],
    "requiredSelectors": [
      "[data-wd-field=\"listing\"]"
    ],
    "elements": [
      {
        "selector": "[data-wd-field=\"listing\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first",
        "required": true
      }
    ]
  },
  {
    "id": "account-web-field-controls:mime-types",
    "rootSelector": "[data-web-directives=\"mime-types\"]",
    "rootRequired": true,
    "applicableRoutes": [
      "/advanced/mime-types"
    ],
    "requiredSelectors": [
      "[data-wd-field=\"type\"]",
      "[data-wd-field=\"extensions\"]"
    ],
    "elements": [
      {
        "selector": "[data-wd-field=\"type\"]",
        "tags": [
          "input"
        ],
        "attributes": {
          "type": "text"
        },
        "occurrence": "first",
        "required": true
      },
      {
        "selector": "[data-wd-field=\"extensions\"]",
        "tags": [
          "input"
        ],
        "attributes": {
          "type": "text"
        },
        "occurrence": "first",
        "required": true
      }
    ]
  },
  {
    "id": "account-web-field-controls:hotlink",
    "rootSelector": "[data-web-directives=\"hotlink\"]",
    "rootRequired": true,
    "applicableRoutes": [
      "/security/hotlink"
    ],
    "requiredSelectors": [
      "[data-wd-field=\"enabled\"]",
      "[data-wd-field=\"allowedHosts\"]",
      "[data-wd-field=\"extensions\"]",
      "[data-wd-field=\"allowEmptyReferrer\"]",
      "[data-wd-field=\"action\"]",
      "[data-wd-field=\"redirectUrl\"]"
    ],
    "elements": [
      {
        "selector": "[data-wd-field=\"enabled\"]",
        "tags": [
          "input"
        ],
        "attributes": {
          "type": "checkbox"
        },
        "occurrence": "first",
        "required": true
      },
      {
        "selector": "[data-wd-field=\"allowedHosts\"]",
        "tags": [
          "textarea"
        ],
        "attributes": {},
        "occurrence": "first",
        "required": true
      },
      {
        "selector": "[data-wd-field=\"extensions\"]",
        "tags": [
          "input"
        ],
        "attributes": {
          "type": "text"
        },
        "occurrence": "first",
        "required": true
      },
      {
        "selector": "[data-wd-field=\"allowEmptyReferrer\"]",
        "tags": [
          "input"
        ],
        "attributes": {
          "type": "checkbox"
        },
        "occurrence": "first",
        "required": true
      },
      {
        "selector": "[data-wd-field=\"action\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first",
        "required": true
      },
      {
        "selector": "[data-wd-field=\"redirectUrl\"]",
        "tags": [
          "input"
        ],
        "attributes": {
          "type": "text"
        },
        "occurrence": "first",
        "required": true
      }
    ]
  },
  {
    "id": "account-web-field-controls:ip-blocker",
    "rootSelector": "[data-web-directives=\"ip-blocker\"]",
    "rootRequired": true,
    "applicableRoutes": [
      "/security/ip-blocker"
    ],
    "requiredSelectors": [
      "[data-wd-field=\"address\"]"
    ],
    "elements": [
      {
        "selector": "[data-wd-field=\"address\"]",
        "tags": [
          "input"
        ],
        "attributes": {
          "type": "text"
        },
        "occurrence": "first",
        "required": true
      }
    ]
  },
  {
    "id": "account-web-field-controls:redirects",
    "rootSelector": "[data-web-directives=\"redirects\"]",
    "rootRequired": true,
    "applicableRoutes": [
      "/domains/redirects"
    ],
    "requiredSelectors": [
      "[data-wd-field=\"status\"]",
      "[data-wd-field=\"path\"]",
      "[data-wd-field=\"target\"]"
    ],
    "elements": [
      {
        "selector": "[data-wd-field=\"status\"]",
        "tags": [
          "select"
        ],
        "attributes": {},
        "occurrence": "first",
        "required": true
      },
      {
        "selector": "[data-wd-field=\"path\"]",
        "tags": [
          "input"
        ],
        "attributes": {
          "type": "text"
        },
        "occurrence": "first",
        "required": true
      },
      {
        "selector": "[data-wd-field=\"target\"]",
        "tags": [
          "input"
        ],
        "attributes": {
          "type": "text"
        },
        "occurrence": "first",
        "required": true
      }
    ]
  },
{
  "id": "ui-theme-preferences",
  "rootSelector": "[data-ui-theme-preferences]",
  "routeScope": {
    "kind": "authenticated",
    "surfaces": [
      "xpanel",
      "xwhm",
      "xmail"
    ]
  },
  "requiredSelectors": [
    "form[data-ui-theme-form]",
    "select[data-ui-theme-choice]",
    "button[data-ui-theme-save]",
    "button[data-ui-theme-reload]",
    "[data-ui-theme-status]"
  ],
  "elements": [
    {
      "selector": "[data-ui-theme-save]",
      "tags": [
        "button"
      ],
      "attributes": {
        "type": "submit"
      },
      "occurrence": "every"
    },
    {
      "selector": "[data-ui-theme-reload]",
      "tags": [
        "button"
      ],
      "attributes": {
        "type": "button"
      },
      "occurrence": "every"
    }
  ],
  "semanticRelations": [
    {
      "selector": "[data-ui-theme-choice]",
      "ancestorHook": "form[data-ui-theme-form]",
      "tag": "select"
    },
    {
      "selector": "[data-ui-theme-save]",
      "ancestorHook": "form[data-ui-theme-form]",
      "tag": "button"
    }
  ],
  "variants": [
    {
      "id": "ui-theme-preferences:unique:1",
      "rootSelector": "[data-ui-theme-preferences]",
      "scopeSelector": "form[data-ui-theme-form]",
      "scopeCount": 1,
      "requiredSelectors": []
    },
    {
      "id": "ui-theme-preferences:unique:2",
      "rootSelector": "[data-ui-theme-preferences]",
      "scopeSelector": "select[data-ui-theme-choice]",
      "scopeCount": 1,
      "requiredSelectors": []
    },
    {
      "id": "ui-theme-preferences:unique:3",
      "rootSelector": "[data-ui-theme-preferences]",
      "scopeSelector": "button[data-ui-theme-save]",
      "scopeCount": 1,
      "requiredSelectors": []
    },
    {
      "id": "ui-theme-preferences:unique:4",
      "rootSelector": "[data-ui-theme-preferences]",
      "scopeSelector": "button[data-ui-theme-reload]",
      "scopeCount": 1,
      "requiredSelectors": []
    },
    {
      "id": "ui-theme-preferences:unique:5",
      "rootSelector": "[data-ui-theme-preferences]",
      "scopeSelector": "[data-ui-theme-status]",
      "scopeCount": 1,
      "requiredSelectors": []
    }
  ]
},
{
  "id": "panel-home-tools",
  "rootSelector": "[data-panel-home]",
  "applicableRoutes": [
    "/home"
  ],
  "qualifiedOnly": false,
  "ownScopeOnly": true,
  "requiredSelectors": [
    "input[data-home-filter]",
    "#tool-filter-count",
    "[data-tool-section]",
    "[data-tool-empty]"
  ],
  "optionalSelectors": [
    "[data-tool-group]",
    "[data-tool]",
    "[data-group-count]",
    "[data-home-empty-title]",
    "[data-home-filter-clear]"
  ],
  "elements": [
    {
      "selector": "[data-home-filter]",
      "tags": [
        "input"
      ],
      "occurrence": "every"
    },
    {
      "selector": "[data-home-filter-clear]",
      "tags": [
        "button"
      ],
      "required": false,
      "occurrence": "every"
    }
  ],
  "relations": [
    {
      "targetId": "tool-filter-count",
      "sameRoot": "[data-panel-home]",
      "targetMustBeUnique": true,
      "required": true
    }
  ],
  "variants": [
    {
      "id": "panel-home-tools:unique:1",
      "rootSelector": "[data-panel-home]",
      "scopeSelector": "input[data-home-filter]",
      "scopeCount": 1,
      "requiredSelectors": [],
      "ownScopeOnly": true
    },
    {
      "id": "panel-home-tools:unique:2",
      "rootSelector": "[data-panel-home]",
      "scopeSelector": "#tool-filter-count",
      "scopeCount": 1,
      "requiredSelectors": [],
      "ownScopeOnly": true
    },
    {
      "id": "panel-home-tools:unique:3",
      "rootSelector": "[data-panel-home]",
      "scopeSelector": "[data-tool-section]",
      "scopeCount": 1,
      "requiredSelectors": [],
      "ownScopeOnly": true
    },
    {
      "id": "panel-home-tools:unique:4",
      "rootSelector": "[data-panel-home]",
      "scopeSelector": "[data-tool-empty]",
      "scopeCount": 1,
      "requiredSelectors": [],
      "ownScopeOnly": true
    }
  ],
  "documentAttributes": {
    "data-ui-theme": "v2"
  }
},
{
  "id": "whm-transfer-import-projections",
  "rootSelector": "[data-transfer-workspace]",
  "applicableRoutes": [
    "/whm/transfers"
  ],
  "lookupScope": {
    "kind": "closest",
    "selector": "[data-whm-detail-route]"
  },
  "scopeSelector": "[data-whm-detail-section=\"transfer-import\"]",
  "scopeCount": 1,
  "requiredSelectors": [
    "tbody[data-transfer-import-warnings]",
    "tbody[data-transfer-import-domains], [data-transfer-import-part=\"domains\"] tbody",
    "tbody[data-transfer-import-home], [data-transfer-import-part=\"home\"] tbody",
    "tbody[data-transfer-import-databases], [data-transfer-import-part=\"databases\"] tbody",
    "tbody[data-transfer-import-mail], [data-transfer-import-part=\"mail\"] tbody",
    "tbody[data-transfer-import-dns], [data-transfer-import-part=\"dns\"] tbody"
  ],
  "optionalSelectors": [
    "[data-transfer-import-observation]"
  ]
},
{
  "id": "account-mailing-lists",
  "rootSelector": "[data-mailing-lists]",
  "applicableRoutes": [
    "/email/mailing-lists"
  ],
  "requiredSelectors": [
    "tbody[data-mailing-lists-rows]",
    "[data-mailing-list-status]",
    "input[data-ml-name]",
    "select[data-ml-domain]",
    "textarea[data-ml-members]",
    "select[data-ml-moderation]",
    "input[data-ml-archive]",
    "button[data-ml-create]"
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"account-mailing-list-row\"]",
      "requiredSelectors": [
        "tr",
        "[data-xp-slot=\"address\"]",
        "[data-xp-slot=\"members\"]",
        "[data-xp-slot=\"moderation\"]",
        "[data-xp-slot=\"archive\"]",
        "button[data-xp-slot=\"remove\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"account-mailing-list-empty\"]",
      "requiredSelectors": [
        "tr",
        "[data-xp-slot=\"message\"]"
      ]
    }
  ]
},
{
  "id": "account-sessions",
  "rootSelector": "[data-account-sessions]",
  "requiredSelectors": [
    "[data-sessions-rows]",
    "[data-sessions-status]",
    "button[data-sessions-revoke-others]"
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"account-session-row\"]",
      "requiredSelectors": [
        "article",
        "[data-xp-slot=\"title\"]",
        "[data-xp-slot=\"verification\"]",
        "[data-xp-slot=\"network-label\"]",
        "[data-xp-slot=\"network\"]",
        "[data-xp-slot=\"client-label\"]",
        "[data-xp-slot=\"client\"]",
        "[data-xp-slot=\"last-active-label\"]",
        "[data-xp-slot=\"last-active\"]",
        "[data-xp-slot=\"expires-label\"]",
        "[data-xp-slot=\"expires\"]",
        "[data-xp-slot=\"actions\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"account-session-action\"]",
      "requiredSelectors": [
        "button",
        "[data-xp-slot=\"label\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"account-session-empty\"]",
      "requiredSelectors": [
        "p",
        "[data-xp-slot=\"message\"]"
      ]
    }
  ],
  "applicableRoutes": [
    "/security/account"
  ]
},
{
  "id": "directory-privacy",
  "rootSelector": "[data-directory-privacy]",
  "applicableRoutes": [
    "/files/directory-privacy"
  ],
  "requiredSelectors": [
    "tbody[data-directory-privacy-rows]",
    "[data-directory-privacy-status]",
    "[data-directory-privacy-preview]",
    "[data-directory-privacy-preview-wrap]",
    "input[data-directory-privacy-path]",
    "input[data-directory-privacy-prompt]",
    "input[data-directory-privacy-username]",
    "input[data-directory-privacy-password]",
    "button[data-directory-privacy-add]",
    "button[data-directory-privacy-save]"
  ],
  "elements": [
    {
      "selector": "[data-directory-privacy-password]",
      "tags": [
        "input"
      ],
      "attributes": {
        "type": "password"
      },
      "occurrence": "every"
    }
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"directory-privacy-rule\"]",
      "requiredSelectors": [
        "tr",
        "bdi[data-xp-slot=\"path\"]",
        "[data-xp-slot=\"prompt\"]",
        "div[data-xp-slot=\"users\"]",
        "input[type=\"checkbox\"][data-xp-slot=\"enabled\"]",
        "button[data-xp-slot=\"remove\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"directory-privacy-user\"]",
      "requiredSelectors": [
        "div",
        "[data-xp-slot=\"name-label\"]",
        "bdi[data-xp-slot=\"username\"]",
        "label[data-xp-slot=\"password-label\"]",
        "input[type=\"password\"][data-xp-slot=\"password\"]",
        "button[data-xp-slot=\"remove\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"directory-privacy-empty\"]",
      "requiredSelectors": [
        "tr",
        "[data-xp-slot=\"message\"]"
      ]
    }
  ]
},
{
  "id": "file-workspace-browse",
  "rootSelector": "[data-file-manager=\"browse\"]",
  "applicableRoutes": [
    "/files/manager"
  ],
  "requiredSelectors": [
    "textarea#jailed-code-editor",
    "[data-file-manager-table] tbody",
    "[data-file-status]",
    "[data-file-current-path]",
    "[data-file-selected-path]"
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"file-row\"]",
      "requiredSelectors": [
        "tr",
        "[data-xp-slot=\"name\"]",
        "[data-xp-slot=\"kind\"]",
        "[data-xp-slot=\"size\"]",
        "[data-xp-slot=\"mode\"]",
        "[data-xp-slot=\"modified\"]",
        "[data-xp-slot=\"actions\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"file-action\"]",
      "requiredSelectors": [
        "button",
        "[data-xp-slot=\"label\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"file-empty-row\"]",
      "requiredSelectors": [
        "tr",
        "[data-xp-slot=\"message\"]"
      ]
    }
  ]
},
{
  "id": "file-workspace-trash",
  "rootSelector": "[data-file-manager=\"trash\"]",
  "applicableRoutes": [
    "/files/trash"
  ],
  "requiredSelectors": [
    "[data-file-manager-table] tbody",
    "[data-file-status]"
  ],
  "optionalSelectors": [
    "[data-trash-empty]"
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"trash-row\"]",
      "requiredSelectors": [
        "tr",
        "[data-xp-slot=\"name\"]",
        "[data-xp-slot=\"kind\"]",
        "[data-xp-slot=\"size\"]",
        "[data-xp-slot=\"mode\"]",
        "[data-xp-slot=\"modified\"]",
        "[data-xp-slot=\"actions\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"trash-action\"]",
      "requiredSelectors": [
        "button",
        "[data-xp-slot=\"label\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"trash-purge-action\"]",
      "requiredSelectors": [
        "button",
        "[data-xp-slot=\"label\"]"
      ]
    }
  ]
},
{
  "id": "mail-attachments-root",
  "rootSelector": "[data-mail-attachments]",
  "applicableRoutes": [
    "/mail/search",
    "/mail/later"
  ],
  "requiredSelectors": [
    "[data-attachment-status]",
    "[data-attachment-list]",
    "[data-attachment-refresh]"
  ],
  "elements": [
    {
      "selector": "[data-attachment-status]",
      "tags": [
        "p"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-attachment-list]",
      "tags": [
        "ul"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-attachment-refresh]",
      "tags": [
        "button"
      ],
      "attributes": {
        "type": "button"
      },
      "occurrence": "every",
      "required": true
    }
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"mail-attachment-row\"]",
      "requiredSelectors": [
        "li",
        "a[data-xp-slot=\"link\"]",
        "span[data-xp-slot=\"badge\"]",
        "bdi[data-xp-slot=\"name\"]",
        "bdi[data-xp-slot=\"size\"]"
      ]
    }
  ],
  "optionalSelectors": [
    "[data-attachment-heading]"
  ]
},
{
  "id": "mail-attachments-mounted-reading-root",
  "rootSelector": "[data-mail-attachments]",
  "applicableRoutes": [
    "/mail/inbox",
    "/mail/sent",
    "/mail/drafts",
    "/mail/trash"
  ],
  "requiredSelectors": [
    "[data-attachment-status]",
    "[data-attachment-list]",
    "[data-attachment-refresh]"
  ],
  "elements": [
    {
      "selector": "[data-attachment-status]",
      "tags": [
        "p"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-attachment-list]",
      "tags": [
        "ul"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-attachment-refresh]",
      "tags": [
        "button"
      ],
      "attributes": {
        "type": "button"
      },
      "occurrence": "every",
      "required": true
    }
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"mail-attachment-row\"]",
      "requiredSelectors": [
        "li",
        "a[data-xp-slot=\"link\"]",
        "span[data-xp-slot=\"badge\"]",
        "bdi[data-xp-slot=\"name\"]",
        "bdi[data-xp-slot=\"size\"]"
      ]
    }
  ],
  "optionalSelectors": [
    "[data-attachment-heading]"
  ],
  "rootRequired": false
},
{
  "id": "mail-compose-attachments-root",
  "rootSelector": "[data-compose-attachments]",
  "applicableRoutes": [
    "/mail/compose"
  ],
  "requiredSelectors": [
    "[data-compose-attachment-open]",
    "[data-compose-attachment-input]",
    "[data-compose-attachment-list]",
    "[data-compose-attachment-status]"
  ],
  "elements": [
    {
      "selector": "[data-compose-attachment-open]",
      "tags": [
        "button"
      ],
      "attributes": {
        "type": "button"
      },
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-compose-attachment-input]",
      "tags": [
        "input"
      ],
      "attributes": {
        "type": "file",
        "multiple": true
      },
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-compose-attachment-list]",
      "tags": [
        "ul"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-compose-attachment-status]",
      "tags": [
        "p",
        "span"
      ],
      "occurrence": "every",
      "required": true,
      "attributes": {
        "role": "status"
      }
    }
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"mail-compose-attachment-row\"]",
      "requiredSelectors": [
        "li",
        "bdi[data-xp-slot=\"name\"]",
        "bdi[data-xp-slot=\"size\"]",
        "button[data-xp-slot=\"remove\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"mail-compose-attachment-dismiss\"]",
      "requiredSelectors": [
        "button[data-xp-slot=\"label\"]"
      ]
    }
  ],
  "optionalSelectors": [
    "[data-compose-attachment-summary]"
  ]
},
{
  "id": "mail-contacts-tools-root",
  "rootSelector": "[data-mail-contacts-tools]",
  "applicableRoutes": [
    "/mail/contacts"
  ],
  "requiredSelectors": [
    "[data-contacts-import-text]",
    "[data-contacts-import]",
    "[data-contacts-export]",
    "[data-contacts-shares]"
  ],
  "elements": [
    {
      "selector": "[data-contacts-import-text]",
      "tags": [
        "textarea"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-contacts-import]",
      "tags": [
        "button"
      ],
      "attributes": {
        "type": "button"
      },
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-contacts-export]",
      "tags": [
        "button"
      ],
      "attributes": {
        "type": "button"
      },
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-contacts-shares]",
      "tags": [
        "ul"
      ],
      "occurrence": "every",
      "required": true
    }
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"mail-contact-share\"]",
      "requiredSelectors": [
        "li",
        "bdi[data-xp-slot=\"address\"]",
        "span[data-xp-slot=\"permission\"]",
        "button[data-xp-slot=\"remove\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"mail-contact-share-empty\"]",
      "requiredSelectors": [
        "li[data-xp-slot=\"message\"]"
      ]
    }
  ],
  "optionalSelectors": [
    "[data-contacts-import-file]",
    "[data-contacts-import-preview]",
    "[data-contacts-import-status]",
    "[data-contacts-export-status]",
    "[data-contacts-share-contact]",
    "[data-contacts-share-principal]",
    "[data-contacts-share-permission]",
    "[data-contacts-share-add]",
    "[data-contacts-share-status]"
  ]
},
{
  "id": "mail-identities-root",
  "rootSelector": "[data-mail-identities]",
  "applicableRoutes": [
    "/mail/settings/identities"
  ],
  "requiredSelectors": [
    "[data-identities-rows]",
    "[data-identities-status]",
    "[data-identities-display-name]",
    "[data-identities-reply-to]",
    "[data-identities-text-signature]",
    "[data-identities-html-signature]",
    "[data-identities-default]",
    "[data-identities-save]"
  ],
  "elements": [
    {
      "selector": "[data-identities-rows]",
      "tags": [
        "div"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-identities-status]",
      "tags": [
        "p"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-identities-display-name]",
      "tags": [
        "input"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-identities-reply-to]",
      "tags": [
        "input"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-identities-text-signature]",
      "tags": [
        "textarea"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-identities-html-signature]",
      "tags": [
        "textarea"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-identities-default]",
      "tags": [
        "input"
      ],
      "attributes": {
        "type": "checkbox"
      },
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-identities-save]",
      "tags": [
        "button"
      ],
      "attributes": {
        "type": "button"
      },
      "occurrence": "every",
      "required": true
    }
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"mail-identity-card\"]",
      "requiredSelectors": [
        "article",
        "strong[data-xp-slot=\"name\"]",
        "span[data-xp-slot=\"badge\"]",
        "dl[data-xp-slot=\"facts\"]",
        "div[data-xp-slot=\"actions\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"mail-identity-fact\"]",
      "requiredSelectors": [
        "div",
        "dt[data-xp-slot=\"label\"]",
        "bdi[data-xp-slot=\"value\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"mail-identity-action\"]",
      "requiredSelectors": [
        "button[data-xp-slot=\"label\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"mail-identity-empty\"]",
      "requiredSelectors": [
        "p[data-xp-slot=\"message\"]"
      ]
    }
  ],
  "optionalSelectors": [
    "[data-identities-form-title]",
    "[data-identities-reset]",
    "#identities-email"
  ]
},
{
  "id": "mail-mailbox-forwarders-root",
  "rootSelector": "[data-mail-forwarders]",
  "applicableRoutes": [
    "/mail/settings/forwarders"
  ],
  "requiredSelectors": [
    "[data-forwarders-status]",
    "[data-forwarders-rows]",
    "[data-forwarders-count]",
    "input[name=\"destination\"]",
    "[data-forwarders-add]",
    "[data-forwarders-refresh]"
  ],
  "elements": [
    {
      "selector": "[data-forwarders-status]",
      "tags": [
        "p"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-forwarders-rows]",
      "tags": [
        "tbody"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "input[name=\"destination\"]",
      "tags": [
        "input"
      ],
      "attributes": {
        "type": "email"
      },
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-forwarders-add]",
      "tags": [
        "button"
      ],
      "attributes": {
        "type": "button"
      },
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-forwarders-refresh]",
      "tags": [
        "button"
      ],
      "attributes": {
        "type": "button"
      },
      "occurrence": "every",
      "required": true
    }
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"mail-forwarder-row\"]",
      "requiredSelectors": [
        "tr",
        "bdi[data-xp-slot=\"address\"]",
        "button[data-xp-slot=\"remove\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"mail-forwarder-empty\"]",
      "requiredSelectors": [
        "tr",
        "td[data-xp-slot=\"message\"]"
      ]
    }
  ],
  "optionalSelectors": [
    "[data-forwarders-application]"
  ]
},
{
  "id": "mail-mailing-lists-root",
  "rootSelector": "[data-mail-mailing-lists]",
  "applicableRoutes": [
    "/mail/tools/mailing-lists"
  ],
  "requiredSelectors": [
    "[data-lists-status]",
    "[data-lists-rows]",
    "[data-lists-refresh]"
  ],
  "elements": [
    {
      "selector": "[data-lists-status]",
      "tags": [
        "p"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-lists-rows]",
      "tags": [
        "tbody"
      ],
      "occurrence": "every",
      "required": true
    },
    {
      "selector": "[data-lists-refresh]",
      "tags": [
        "button"
      ],
      "attributes": {
        "type": "button"
      },
      "occurrence": "every",
      "required": true
    }
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"mail-membership-row\"]",
      "requiredSelectors": [
        "tr",
        "bdi[data-xp-slot=\"address\"]",
        "td[data-xp-slot=\"name\"]",
        "td[data-xp-slot=\"observed\"]",
        "td[data-xp-slot=\"subscription\"]",
        "td[data-xp-slot=\"posting\"]",
        "td[data-xp-slot=\"membership\"]",
        "button[data-xp-slot=\"action\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"mail-membership-empty\"]",
      "requiredSelectors": [
        "tr",
        "td[data-xp-slot=\"message\"]"
      ]
    }
  ],
  "optionalSelectors": []
},
{
  "id": "acct-transfer-credentials",
  "rootSelector": "[data-acct-transfer-credentials]",
  "applicableRoutes": [
    "/whm/transfers/server"
  ],
  "requiredSelectors": [
    "[data-acct-transfer-credentials-status]",
    "tbody[data-acct-transfer-credentials-rows]",
    "[data-acct-transfer-credentials-loading]",
    "[data-acct-transfer-credentials-empty]",
    "[data-acct-transfer-credentials-form]",
    "input[data-acct-transfer-credential-input=\"label\"]",
    "input[type=\"password\"][data-acct-transfer-credential-input=\"token\"]",
    "button[data-acct-transfer-credential-save]",
    "button[type=\"button\"][data-acct-transfer-credentials-refresh]"
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"transfer-credential-row\"]",
      "requiredSelectors": [
        "tr",
        "button[type=\"button\"][data-xp-action=\"remove\"][disabled]",
        "[data-xp-slot=\"label\"]",
        "[data-xp-slot=\"fingerprint\"]",
        "[data-xp-slot=\"created\"]",
        "[data-xp-slot=\"actor\"]",
        "[data-xp-slot=\"remove-label\"]"
      ]
    }
  ]
},
{
  "id": "approved-host-services",
  "rootSelector": "[data-host-services]",
  "applicableRoutes": [
    "/whm/services"
  ],
  "requiredSelectors": [
    "tbody[data-host-service-rows]",
    "[data-host-service-status]"
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"host-service-row\"]",
      "requiredSelectors": [
        "tr",
        "button[type=\"button\"][data-xp-action=\"restart\"][disabled]",
        "[data-xp-slot=\"service\"]",
        "[data-xp-slot=\"unit\"]",
        "[data-xp-slot=\"state\"]",
        "[data-xp-slot=\"restart-label\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"host-service-empty\"]",
      "requiredSelectors": [
        "tr",
        "td[data-xp-slot=\"message\"]"
      ]
    }
  ]
},
{
  "id": "sw-addon-services",
  "rootSelector": "[data-sw-addons]",
  "applicableRoutes": [
    "/whm/software/addon-services"
  ],
  "requiredSelectors": [
    "[data-sw-addons-status]",
    "button[type=\"button\"][data-sw-addons-refresh]",
    "tbody[data-sw-addons-rows]",
    "[data-sw-addons-job]",
    "a[data-sw-addons-job-link]"
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"software-addon-row\"]",
      "requiredSelectors": [
        "tr",
        "button[type=\"button\"][data-xp-action=\"start\"][disabled]",
        "button[type=\"button\"][data-xp-action=\"stop\"][disabled]",
        "button[type=\"button\"][data-xp-action=\"restart\"][disabled]",
        "[data-xp-slot=\"service\"]",
        "[data-xp-slot=\"kind\"]",
        "[data-xp-slot=\"package\"]",
        "[data-xp-slot=\"unit\"]",
        "[data-xp-slot=\"state\"]",
        "[data-xp-slot=\"boot\"]",
        "[data-xp-slot=\"start-label\"]",
        "[data-xp-slot=\"stop-label\"]",
        "[data-xp-slot=\"restart-label\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"software-addon-empty\"]",
      "requiredSelectors": [
        "tr",
        "td[data-xp-slot=\"message\"]"
      ]
    }
  ]
},
{
  "id": "sw-app-projects",
  "rootSelector": "[data-sw-projects]",
  "applicableRoutes": [
    "/whm/software/application-projects"
  ],
  "requiredSelectors": [
    "[data-sw-projects-status]",
    "button[type=\"button\"][data-sw-projects-refresh]",
    "tbody[data-sw-projects-runtimes]"
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"software-project-runtime-row\"]",
      "requiredSelectors": [
        "tr",
        "[data-xp-slot=\"name\"]",
        "[data-xp-slot=\"state\"]",
        "[data-xp-slot=\"version\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"software-project-runtime-empty\"]",
      "requiredSelectors": [
        "tr",
        "td[data-xp-slot=\"message\"]"
      ]
    }
  ]
},
{
  "id": "whm-ips",
  "rootSelector": "[data-whm-ip-pool]",
  "applicableRoutes": [
    "/whm/server/ips"
  ],
  "requiredSelectors": [
    "form[data-add-ip-form]",
    "[data-add-ip-form] button[type=\"submit\"]",
    "[data-ip-pool-table] tbody",
    "[data-add-ip-status]",
    "[data-ip-pool-status]",
    "[data-ip-pool-count-label]"
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"whm-ip-row\"]",
      "requiredSelectors": [
        "tr",
        "span[data-xp-action=\"role\"]",
        "span[data-xp-action=\"primary\"]",
        "button[type=\"button\"][data-xp-action=\"remove\"][disabled]",
        "[data-xp-slot=\"address\"]",
        "[data-xp-slot=\"version\"]",
        "[data-xp-slot=\"interface\"]",
        "[data-xp-slot=\"owner\"]",
        "[data-xp-slot=\"ptr\"]",
        "[data-xp-slot=\"remove-label\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"whm-ip-empty\"]",
      "requiredSelectors": [
        "tr",
        "td[data-xp-slot=\"message\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"whm-ip-role-web\"]",
      "requiredSelectors": [
        "span",
        "[data-xp-slot=\"label\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"whm-ip-role-mail\"]",
      "requiredSelectors": [
        "span",
        "[data-xp-slot=\"label\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"whm-ip-primary\"]",
      "requiredSelectors": [
        "span",
        "[data-xp-slot=\"label\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"whm-ip-secondary\"]",
      "requiredSelectors": [
        "span",
        "[data-xp-slot=\"label\"]"
      ]
    }
  ]
},
{
  "id": "whm-local-archives",
  "rootSelector": "[data-account-backups]",
  "rootRequired": false,
  "routeScope": {
    "kind": "authenticated",
    "surfaces": [
      "xwhm"
    ]
  },
  "requiredSelectors": [
    "select[data-backup-account]",
    "tbody[data-backup-files]",
    "[data-backup-status]",
    "button[data-backup-create]",
    "button[data-backup-local-read]"
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"whm-local-archive-row\"]",
      "requiredSelectors": [
        "tr",
        "[data-xp-slot=\"archive\"]",
        "[data-xp-slot=\"bytes\"]",
        "a[data-xp-slot=\"review\"]"
      ]
    }
  ]
},
{
  "id": "whm-panel-data",
  "rootSelector": "[data-whm-generations]",
  "applicableRoutes": [
    "/whm/panel/data"
  ],
  "requiredSelectors": [
    "[data-generations-status]",
    "tbody[data-generation-rows]"
  ],
  "optionalSelectors": [
    "[data-generations-current]",
    "[data-action=\"rollback-generation\"]"
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"whm-generation-row\"]",
      "requiredSelectors": [
        "tr",
        "[data-xp-slot=\"generation\"]",
        "[data-xp-slot=\"created\"]",
        "[data-xp-slot=\"summary\"]",
        "[data-xp-slot=\"state\"]",
        "[data-xp-slot=\"actions\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"whm-generation-empty\"]",
      "requiredSelectors": [
        "tr",
        "td[data-xp-slot=\"content\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"whm-generation-rollback\"]",
      "requiredSelectors": [
        "button[type=\"button\"][disabled]",
        "[data-xp-slot=\"content\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"whm-generation-state-active\"]",
      "requiredSelectors": [
        "span",
        "[data-xp-slot=\"content\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"whm-generation-state-other\"]",
      "requiredSelectors": [
        "span",
        "[data-xp-slot=\"content\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"whm-generation-current-active\"]",
      "requiredSelectors": [
        "span",
        "[data-xp-slot=\"content\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"whm-generation-current-none\"]",
      "requiredSelectors": [
        "span",
        "[data-xp-slot=\"content\"]"
      ]
    }
  ]
},
{
  "id": "zone-editor",
  "rootSelector": "[data-dns-editor]",
  "applicableRoutes": [
    "/domains/zone-editor",
    "/whm/dns"
  ],
  "requiredSelectors": [
    "select[data-dns-zone]",
    "select[data-dns-account]",
    "input[data-dns-new-name]",
    "tbody[data-dns-records]",
    "[data-dns-status]",
    "button[data-dns-add-record]",
    "button[data-dns-add-zone]",
    "button[data-dns-save]",
    "button[data-dns-delete]"
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"dns-record-row\"]",
      "requiredSelectors": [
        "tr",
        "input[type=\"text\"][data-xp-slot=\"name\"][disabled]",
        "select[data-xp-slot=\"type\"][disabled]",
        "input[type=\"number\"][data-xp-slot=\"ttl\"][disabled]",
        "input[type=\"text\"][data-xp-slot=\"content\"][disabled]",
        "input[type=\"number\"][data-xp-slot=\"priority\"][disabled]",
        "button[type=\"button\"][data-xp-slot=\"remove\"][disabled]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"dns-record-empty\"]",
      "requiredSelectors": [
        "tr",
        "td[data-xp-slot=\"message\"]"
      ]
    }
  ]
},
{
  "id": "sw-containers-list",
  "rootSelector": "[data-sw-containers][data-sw-can-read]",
  "applicableRoutes": [
    "/whm/software/containers"
  ],
  "requiredSelectors": [
    "[data-sw-status]",
    "button[data-sw-refresh]",
    "tbody[data-sw-containers]",
    "select[data-sw-filter-engine]",
    "input[data-sw-filter-search]",
    "[data-sw-job]",
    "a[data-sw-job-link]"
  ],
  "optionalSelectors": [
    "[data-sw-engine-state]",
    "[data-sw-observed]"
  ],
  "templateScopes": [
    {
      "templateSelector": "template[data-xp-template=\"software-container-row\"]",
      "requiredSelectors": [
        "tr",
        "[data-xp-slot=\"name\"]",
        "[data-xp-slot=\"engine\"]",
        "[data-xp-slot=\"image\"]",
        "[data-xp-slot=\"state\"]",
        "[data-xp-slot=\"status\"]",
        "[data-xp-slot=\"ports\"]",
        "button[type=\"button\"][data-xp-action=\"start\"][disabled]",
        "button[type=\"button\"][data-xp-action=\"stop\"][disabled]",
        "button[type=\"button\"][data-xp-action=\"restart\"][disabled]",
        "[data-xp-slot=\"start-label\"]",
        "[data-xp-slot=\"stop-label\"]",
        "[data-xp-slot=\"restart-label\"]"
      ]
    },
    {
      "templateSelector": "template[data-xp-template=\"software-container-empty\"]",
      "requiredSelectors": [
        "tr",
        "td[data-xp-slot=\"message\"]"
      ]
    }
  ]
}
]
