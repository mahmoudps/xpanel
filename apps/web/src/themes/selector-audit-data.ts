// Source-bound classifications for the core browser selector audit. Runtime rendering does not run the audit.
export type SelectorMethod = 'querySelector' | 'querySelectorAll' | 'closest' | 'matches' | 'getElementById'
export interface SelectorSiteReview {
  readonly line: number
  readonly column: number
  readonly method: SelectorMethod
  readonly argument: string
  readonly classification: string
  readonly controllers: readonly string[]
}
export interface SelectorSourceReview {
  readonly path: string
  /** SHA-256 of the UTF-8 source after CRLF is normalized to LF. */
  readonly sha256: string
  readonly sites: readonly SelectorSiteReview[]
}
export const SELECTOR_SOURCE_REVIEWS: readonly SelectorSourceReview[] = [
  {
    "path": "apps/web/src/account-backup-client.ts",
    "sha256": "7cb32f5757f55c0b9529e6f58c07f7b11723cf6b578ce951b9bde092de35b5d8",
    "sites": [
      {
        "line": 67,
        "column": 94,
        "method": "querySelector",
        "argument": "'[data-account-backup-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-backup"
        ]
      },
      {
        "line": 71,
        "column": 118,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-cron-client.ts",
    "sha256": "79982576b1d98c8bbf1d712f43c4986e27b1b2bb54371e9173f29f6c16d5634a",
    "sites": [
      {
        "line": 98,
        "column": 135,
        "method": "querySelector",
        "argument": "'[data-cron-field=\"' + key + '\"]'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-cron"
        ]
      },
      {
        "line": 99,
        "column": 94,
        "method": "querySelector",
        "argument": "'[data-cron-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-cron"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-database-insights-client.ts",
    "sha256": "b93aebb8c097e9c011f4f6674896604b809ea45c9f46707681f3035425b5a9ab",
    "sites": [
      {
        "line": 63,
        "column": 88,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-database-insights"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-database-remote-client.ts",
    "sha256": "d42557e9517a1670adcab4b7eaede60f2619c3df4c19eeb7dc4faa255bddb79b",
    "sites": [
      {
        "line": 59,
        "column": 84,
        "method": "querySelector",
        "argument": "'[data-remote-' + name + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-database-remote"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-dynamic-dns-client.ts",
    "sha256": "217d101a4dfe1c7952507dd13e53691ae06926212843ca7c31cc66f80ea32d9e",
    "sites": [
      {
        "line": 38,
        "column": 84,
        "method": "querySelector",
        "argument": "'[data-ddns-' + name + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-dynamic-dns"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-filters-client.ts",
    "sha256": "02e702a77e98d44022424ba6aa3e0b8ce622117d7c1cfcade1ed738c670e1c98",
    "sites": [
      {
        "line": 111,
        "column": 38,
        "method": "closest",
        "argument": "blockedAncestor",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 178,
        "column": 32,
        "method": "closest",
        "argument": "blockedAncestor",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 197,
        "column": 100,
        "method": "closest",
        "argument": "blockedAncestor",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 233,
        "column": 77,
        "method": "querySelector",
        "argument": "'[data-'+key+'-field=\"'+name+'\"]'",
        "classification": "finite-nested-client-row",
        "controllers": [
          "account-filters"
        ]
      },
      {
        "line": 238,
        "column": 105,
        "method": "closest",
        "argument": "blockedAncestor",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 284,
        "column": 60,
        "method": "closest",
        "argument": "blockedAncestor",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 285,
        "column": 95,
        "method": "querySelector",
        "argument": "'[name=\"'+name+'\"]'",
        "classification": "finite-nested-named-form",
        "controllers": [
          "account-filters"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-forwarders-client.ts",
    "sha256": "19627ef3a13e447440fcda2692a8fefb1c915e3a7395ebf759de81c9d1f2d547",
    "sites": [
      {
        "line": 70,
        "column": 52,
        "method": "querySelector",
        "argument": "`[data-${key}-status]`",
        "classification": "finite-nullable-section-key",
        "controllers": [
          "account-forwarders"
        ]
      },
      {
        "line": 77,
        "column": 117,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 80,
        "column": 38,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 87,
        "column": 98,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 281,
        "column": 59,
        "method": "querySelector",
        "argument": "`input[name=\"default-kind\"][value=\"${String(record?.kind ?? 'reject')}\"]`",
        "classification": "nullable-provider-row-lookup",
        "controllers": [
          "account-forwarders"
        ]
      },
      {
        "line": 289,
        "column": 60,
        "method": "querySelector",
        "argument": "`input[name=\"default-kind\"][value=\"${String(record?.kind ?? 'reject')}\"]`",
        "classification": "nullable-provider-row-lookup",
        "controllers": [
          "account-forwarders"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-git-client.ts",
    "sha256": "59a1a570b424e09f2072f6ebecac9e195635d33092e7610c64d61aad2ff04758",
    "sites": [
      {
        "line": 46,
        "column": 82,
        "method": "querySelector",
        "argument": "'[data-git-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-git"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-htaccess-client.ts",
    "sha256": "0151c7609f31165b734c68b31736d696c3095080851cc4c06bd2a5a7a6cd0a64",
    "sites": [
      {
        "line": 122,
        "column": 113,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 123,
        "column": 94,
        "method": "querySelector",
        "argument": "'[data-htaccess-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-htaccess"
        ]
      },
      {
        "line": 158,
        "column": 57,
        "method": "querySelector",
        "argument": "'[data-htaccess-php-' + name + ']'",
        "classification": "finite-nullable-preview",
        "controllers": [
          "account-htaccess"
        ]
      },
      {
        "line": 158,
        "column": 133,
        "method": "querySelector",
        "argument": "'[data-htaccess-php-' + name + '-note]'",
        "classification": "finite-nullable-preview",
        "controllers": [
          "account-htaccess"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-list.ts",
    "sha256": "287647be4ff5dd0ed8f15f309b7614686ccda81a2961418ee3074c16e041506d",
    "sites": [
      {
        "line": 46,
        "column": 94,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-scoped-plan-preview",
        "controllers": [
          "create-account-plan-preview"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-logs-client.ts",
    "sha256": "0502ff5dae0f12e50397fc63a23a35476274611eb79b2f6f2bab75d27a0a13e2",
    "sites": [
      {
        "line": 60,
        "column": 83,
        "method": "querySelector",
        "argument": "'[data-logs-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-logs"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-mailing-lists-client.ts",
    "sha256": "b988d59edf3e0923449396caf0adf5b662c70180fe42428103fe47e4bd8268db",
    "sites": [
      {
        "line": 108,
        "column": 85,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-network-tools-client.ts",
    "sha256": "319ce7c7dcaa7262435584574e8aebb1b51818c0167b7651e0a51d2e4f9f1c04",
    "sites": [
      {
        "line": 57,
        "column": 83,
        "method": "querySelector",
        "argument": "'[data-nettools-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-network-tools"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-packages-client.ts",
    "sha256": "441f6e2cca2aa06ca7c14beec06da994f29126342609445567619d089981925f",
    "sites": [
      {
        "line": 49,
        "column": 83,
        "method": "querySelector",
        "argument": "'[data-packages-' + name + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-packages"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-pgp-client.ts",
    "sha256": "2528ee6c0a5dbb2087075ae5c7d1223720dd4dc248657d891ca0eb66f40d7585",
    "sites": [
      {
        "line": 28,
        "column": 86,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-pgp"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-quarantine-client.ts",
    "sha256": "50434e812db1d6d672456f5e8599294ec279cd7d8466c0676e335da3debef0a3",
    "sites": [
      {
        "line": 30,
        "column": 95,
        "method": "querySelector",
        "argument": "'[data-quarantine-' + name + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-quarantine"
        ]
      },
      {
        "line": 40,
        "column": 85,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 59,
        "column": 53,
        "method": "querySelector",
        "argument": "'[data-quarantine-' + name + ']'",
        "classification": "nullable-optional-fact-helper",
        "controllers": [
          "account-quarantine"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-reverse-proxy-client.ts",
    "sha256": "332945d3e33777a009ecc9dff34c7bd3f52542a02a64f97f7ef68eecd51c7205",
    "sites": [
      {
        "line": 75,
        "column": 83,
        "method": "querySelector",
        "argument": "'[data-rp-' + key + ']'",
        "classification": "finite-required-controls",
        "controllers": [
          "account-reverse-proxy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-runtime-client.ts",
    "sha256": "8e9c94ec5706a6c3de292806302333217d2b25f2ce7465ac3eef69dbbea87de5",
    "sites": [
      {
        "line": 15,
        "column": 68,
        "method": "querySelectorAll",
        "argument": "`template[data-xp-template=\"${name}\"]`",
        "classification": "finite-owned-client-template",
        "controllers": [
          "account-runtime"
        ]
      },
      {
        "line": 39,
        "column": 92,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-runtime"
        ]
      },
      {
        "line": 47,
        "column": 109,
        "method": "querySelector",
        "argument": "'[data-runtime-input=\"' + key + '\"]'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-runtime"
        ]
      },
      {
        "line": 49,
        "column": 115,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-sessions-client.ts",
    "sha256": "d11c5f954f0e8091daecb68a9d330353a24f830dec0bf44539de9d4059ee810f",
    "sites": [
      {
        "line": 74,
        "column": 71,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-site-publisher-client.ts",
    "sha256": "ddfb9053c4e46604d3bccad66e28749d5ad20d9133926798d8b5e294803f2246",
    "sites": [
      {
        "line": 61,
        "column": 124,
        "method": "querySelector",
        "argument": "'[data-sitepub-' + name + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-site-publisher"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-spam-client.ts",
    "sha256": "4ec32cc30da63aa4d35626d6b1bf039b3e712729ed045a12b0ccefe0d4c66e78",
    "sites": [
      {
        "line": 117,
        "column": 84,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-spam"
        ]
      },
      {
        "line": 118,
        "column": 77,
        "method": "querySelector",
        "argument": "'[data-spam-score=\"' + id + '\"]'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-spam"
        ]
      },
      {
        "line": 125,
        "column": 85,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-ssh-client.ts",
    "sha256": "7f5923c187635efe687084feb5b96e70ab0fedfcbfb7d95bac0561ec4f7810cb",
    "sites": [
      {
        "line": 58,
        "column": 83,
        "method": "querySelector",
        "argument": "'[data-ssh-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-ssh"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-ssl-client.ts",
    "sha256": "1c4fc322b999a84205f6779da51ce4354e137dfb416c5122c47f9883eb433550",
    "sites": [
      {
        "line": 44,
        "column": 86,
        "method": "querySelector",
        "argument": "'[data-account-ssl-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-ssl"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-virus-scan-client.ts",
    "sha256": "487ec9ab90216f477bda606fc9b35a650a870dd37bd2eee560849f0d2ee3be29",
    "sites": [
      {
        "line": 63,
        "column": 83,
        "method": "querySelector",
        "argument": "'[data-vscan-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-virus-scan"
        ]
      },
      {
        "line": 94,
        "column": 54,
        "method": "querySelector",
        "argument": "`[data-vscan-kpi=\"${key}\"]`",
        "classification": "finite-nullable-page-presentation",
        "controllers": [
          "account-virus-scan"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-web-directives-client.ts",
    "sha256": "0feae67dc44e01f12d778d86e6b814ed0168c6d4d7fcb925bb54523a9af30998",
    "sites": [
      {
        "line": 155,
        "column": 88,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-web-directives"
        ]
      },
      {
        "line": 175,
        "column": 107,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/acct-backup-runs-client.ts",
    "sha256": "dcf071760164fe57933c180c19f4916c98f77054e50b0a2f100492db17d3e356",
    "sites": [
      {
        "line": 106,
        "column": 88,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-backup-runs"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/acct-convert-addon-client.ts",
    "sha256": "20f99b81fa0eb9f2ea0993a6502c3b750a11ebd0713e724b495ccfbcf80a36b3",
    "sites": [
      {
        "line": 64,
        "column": 81,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-convert-addon"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/acct-enhancements-client.ts",
    "sha256": "b0bb5864978eb7961689d9f9f85bf8b0e7eb49655b80b2957c68f9105569b123",
    "sites": [
      {
        "line": 65,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-enhancements"
        ]
      },
      {
        "line": 81,
        "column": 111,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/acct-restore-client.ts",
    "sha256": "ac5a4b14cbf9158047da9e929a618a7c26c0692f89404de92b417d79def2deb7",
    "sites": [
      {
        "line": 84,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-restore-more-' + name + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-restore"
        ]
      },
      {
        "line": 109,
        "column": 152,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/acct-staging-client.ts",
    "sha256": "c56f1e8f76cf932ebfc201b4e75231b4f5e5d270de1687abd106bf510b074285",
    "sites": [
      {
        "line": 53,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-staging-' + name + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-staging"
        ]
      },
      {
        "line": 68,
        "column": 162,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/acct-team-client.ts",
    "sha256": "b6ff17b0c0c55ea048a5ac2c9bf0656ed08ee6ce9a0aa8ff6308b010b224c49b",
    "sites": [
      {
        "line": 66,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-team"
        ]
      },
      {
        "line": 79,
        "column": 112,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/acct-templates-client.ts",
    "sha256": "1df1f9f6afbd893555c9f072963a286bc901fab09907d733ea6a75156da32f11",
    "sites": [
      {
        "line": 44,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-templates"
        ]
      },
      {
        "line": 55,
        "column": 117,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/approved-host-services-client.ts",
    "sha256": "743e7479e44ad720f4055a2eea5e987a999b5b394448e3b2b55dbeca2074f64c",
    "sites": [
      {
        "line": 15,
        "column": 50,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "approved-host-services"
        ]
      },
      {
        "line": 23,
        "column": 135,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/board-port/account-announcements-banner-client.ts",
    "sha256": "eb3d72d50b5d49ac3e88fe77ef77ea388a3c088659fe42e7aa940dce0a6a994c",
    "sites": [
      {
        "line": 97,
        "column": 51,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 101,
        "column": 93,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-source-classified",
        "controllers": [
          "account-announcements-owned-root"
        ]
      },
      {
        "line": 117,
        "column": 45,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 130,
        "column": 134,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 145,
        "column": 154,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 156,
        "column": 47,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/board-port/approved-xwhm-table-filters.ts",
    "sha256": "14682ba6107853885cc295c64589c11b6f727aa63e9c27601abc0b10e90d9756",
    "sites": [
      {
        "line": 50,
        "column": 100,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-forwarded-filter-controls",
        "controllers": [
          "approved-whm-domain-table-filters"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/board-port/xmail-compose.ts",
    "sha256": "ac12f2385b469445d2b95a6f1c621d60d7d713f5673dd68ebf6140d16d31b558",
    "sites": [
      {
        "line": 203,
        "column": 34,
        "method": "querySelector",
        "argument": "'[data-mail-recip=\"' + field + '\"]'",
        "classification": "finite-recipient-kind-controls",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 211,
        "column": 35,
        "method": "querySelector",
        "argument": "'[data-mail-recip=\"' + field + '\"] ul'",
        "classification": "finite-recipient-kind-controls",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 212,
        "column": 36,
        "method": "querySelector",
        "argument": "'[data-mail-recip-input=\"' + field + '\"]'",
        "classification": "finite-recipient-kind-controls",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 419,
        "column": 43,
        "method": "querySelectorAll",
        "argument": "'[data-mail-chip=\"' + field + '\"]'",
        "classification": "runtime-recipient-chip-collection",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 441,
        "column": 41,
        "method": "querySelectorAll",
        "argument": "'[data-mail-chip=\"' + field + '\"]'",
        "classification": "runtime-recipient-chip-collection",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 442,
        "column": 38,
        "method": "querySelector",
        "argument": "'#compose-' + field",
        "classification": "finite-recipient-kind-controls",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/board-port/xmail-inbox.ts",
    "sha256": "4e8ac074dad01203c41db1309738e20a327728f3066901325f085be99c623207",
    "sites": [
      {
        "line": 427,
        "column": 44,
        "method": "querySelector",
        "argument": "'[data-reading-id=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 431,
        "column": 45,
        "method": "querySelector",
        "argument": "'[data-mail-open=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 443,
        "column": 44,
        "method": "querySelector",
        "argument": "selector",
        "classification": "keyed-optional-runtime-reading-projection",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 656,
        "column": 53,
        "method": "querySelector",
        "argument": "'[data-mail-open=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 659,
        "column": 61,
        "method": "querySelector",
        "argument": "'[data-reading-id=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 793,
        "column": 53,
        "method": "querySelector",
        "argument": "'[data-mail-open=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 796,
        "column": 57,
        "method": "querySelector",
        "argument": "'[data-reading-id=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 797,
        "column": 56,
        "method": "querySelector",
        "argument": "'[data-reading-id=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 814,
        "column": 50,
        "method": "querySelector",
        "argument": "'[data-mail-count=\"' + counts[c].getAttribute('data-mail-count') + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 821,
        "column": 32,
        "method": "querySelector",
        "argument": "'[data-mail-count=\"' + observedCounts[n].getAttribute('data-mail-count') + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 828,
        "column": 53,
        "method": "querySelector",
        "argument": "'[data-mail-open=\"' + focus + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/board-port/xpanel-home.ts",
    "sha256": "a843f31e2fd6e0cf12cd8bd42024ee9650453de384ad83b5a28c77553e3dde3e",
    "sites": [
      {
        "line": 1084,
        "column": 41,
        "method": "getElementById",
        "argument": "inputId",
        "classification": "source-classified",
        "controllers": [
          "home-desktop-filter-ids",
          "home-phone-filter-ids"
        ]
      },
      {
        "line": 1085,
        "column": 49,
        "method": "getElementById",
        "argument": "peerId",
        "classification": "source-classified",
        "controllers": [
          "home-desktop-filter-ids",
          "home-phone-filter-ids"
        ]
      },
      {
        "line": 1086,
        "column": 41,
        "method": "getElementById",
        "argument": "countId",
        "classification": "source-classified",
        "controllers": [
          "home-desktop-filter-ids",
          "home-phone-filter-ids"
        ]
      },
      {
        "line": 1087,
        "column": 39,
        "method": "querySelector",
        "argument": "rootSel",
        "classification": "finite-forwarded-root-and-filter-id",
        "controllers": [
          "panel-home-desktop-filter",
          "panel-home-phone-filter"
        ]
      },
      {
        "line": 1200,
        "column": 64,
        "method": "querySelectorAll",
        "argument": "homeFocusSelector",
        "classification": "literal-focus-policy-forwarding",
        "controllers": [
          "panel-home-desktop-filter",
          "panel-home-phone-filter"
        ]
      },
      {
        "line": 1318,
        "column": 43,
        "method": "getElementById",
        "argument": "button.getAttribute('aria-controls') || ''",
        "classification": "source-classified",
        "controllers": [
          "home-group-controls-relation"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/command-palette-client.ts",
    "sha256": "d1b9ec3b9180f7657186e1c6873e574e152511190e97967c3732b69e34fa64f5",
    "sites": [
      {
        "line": 32,
        "column": 48,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "command-palette-history-targets"
        ]
      },
      {
        "line": 33,
        "column": 49,
        "method": "querySelector",
        "argument": "sectionSelector",
        "classification": "source-classified",
        "controllers": [
          "command-palette-history-targets"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/database-workspace-client.ts",
    "sha256": "e85fa90298575de2b60938acfe34bbcaa027385df4dc3c185de40e87a8bb2612",
    "sites": [
      {
        "line": 167,
        "column": 70,
        "method": "querySelector",
        "argument": "'[data-'+key+']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "database-workspace"
        ]
      },
      {
        "line": 215,
        "column": 114,
        "method": "querySelector",
        "argument": "'[name='+key+']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "database-workspace"
        ]
      },
      {
        "line": 217,
        "column": 143,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "database-workspace"
        ]
      },
      {
        "line": 227,
        "column": 98,
        "method": "querySelector",
        "argument": "'[name='+key+']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "database-workspace"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/db-engines-client.ts",
    "sha256": "d9a98eca51aa0e90b234847ce9e06e18511f50800d9dd576aeda7ef435c3fd5d",
    "sites": [
      {
        "line": 120,
        "column": 115,
        "method": "querySelector",
        "argument": "'[data-db-fact=\"' + key + '\"]'",
        "classification": "finite-nullable-page-presentation",
        "controllers": [
          "db-engines"
        ]
      },
      {
        "line": 213,
        "column": 62,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-nullable-page-presentation",
        "controllers": [
          "db-engines"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/directory-privacy-client.ts",
    "sha256": "0c734dd73c16b10e99f050e93c26130db565f90ba9f8828ddd5dc323aaca2215",
    "sites": [
      {
        "line": 139,
        "column": 71,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/domain-workspace-client.ts",
    "sha256": "99bfc2efd1fe743beb410cb76bf8c259fbfb7eb2cc4adb2d055cefb05c616233",
    "sites": [
      {
        "line": 136,
        "column": 96,
        "method": "querySelector",
        "argument": "'[name=\"'+name+'\"]'",
        "classification": "source-classified",
        "controllers": [
          "domain-create-fields"
        ]
      },
      {
        "line": 138,
        "column": 71,
        "method": "querySelector",
        "argument": "'[data-domain-'+name+']'",
        "classification": "source-classified",
        "controllers": [
          "domain-workspace-buttons"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/file-workspace-client.ts",
    "sha256": "0519863de07731a917f146de9359d1e4cc5215b4b71a70d9e082a98ae6a1b084",
    "sites": [
      {
        "line": 146,
        "column": 56,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "file-workspace-browse-presentation",
          "file-workspace-trash-presentation"
        ]
      },
      {
        "line": 178,
        "column": 71,
        "method": "querySelector",
        "argument": "'[data-file-workspace-action=\"'+action+'\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "file-workspace-browse",
          "file-workspace-trash"
        ]
      },
      {
        "line": 194,
        "column": 77,
        "method": "querySelector",
        "argument": "'[data-file-workspace-action=\"'+action+'\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "file-workspace-browse",
          "file-workspace-trash"
        ]
      },
      {
        "line": 195,
        "column": 74,
        "method": "querySelector",
        "argument": "'[data-file-workspace-action=\"'+(browse?'chmod':'purge')+'\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "file-workspace-browse",
          "file-workspace-trash"
        ]
      },
      {
        "line": 266,
        "column": 93,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 277,
        "column": 152,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 321,
        "column": 241,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 365,
        "column": 137,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 389,
        "column": 92,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 401,
        "column": 264,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/login-client.ts",
    "sha256": "8147417abeb29cc696c5d7191fc83ef755112b273c97d0b6884a91f9ed175ec3",
    "sites": [
      {
        "line": 36,
        "column": 58,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "login-credentials",
          "login-enrollment",
          "login-password-change",
          "login-setup"
        ]
      },
      {
        "line": 38,
        "column": 72,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "login-view-switches"
        ]
      },
      {
        "line": 292,
        "column": 43,
        "method": "getElementById",
        "argument": "button.getAttribute('data-target')",
        "classification": "source-classified",
        "controllers": [
          "login-password-toggle-target"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-attachments-client.ts",
    "sha256": "374c15412ab279c7e4831cd7a27958e0d6d0d912aa5ea820dd22d38b1480330f",
    "sites": [
      {
        "line": 40,
        "column": 116,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-calendar-client.ts",
    "sha256": "50c0f26e4684eaefd531b36bf9b8afe7b1494fbbad1883931e7eaa66376cbf7e",
    "sites": [
      {
        "line": 25,
        "column": 131,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 26,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-calendar-' + key + ']'",
        "classification": "source-classified",
        "controllers": [
          "mail-calendar-controls"
        ]
      },
      {
        "line": 27,
        "column": 94,
        "method": "querySelector",
        "argument": "'[data-calendar-' + key + ']'",
        "classification": "source-classified",
        "controllers": [
          "mail-calendar-controls"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-calendar-view-client.ts",
    "sha256": "503a73101a2bce58d2cb57b075a9116598baebee215a9129b7c7b920dbd12ddb",
    "sites": [
      {
        "line": 178,
        "column": 135,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 179,
        "column": 97,
        "method": "querySelector",
        "argument": "'[data-calview-' + key + ']'",
        "classification": "source-classified",
        "controllers": [
          "mail-calendar-view-controls"
        ]
      },
      {
        "line": 180,
        "column": 150,
        "method": "querySelector",
        "argument": "'[data-calview-field=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-calendar-view-controls"
        ]
      },
      {
        "line": 337,
        "column": 39,
        "method": "querySelector",
        "argument": "'[data-calview-day=\"' + calendarDayString(day) + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-calendar-day-focus"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-compose-identities-client.ts",
    "sha256": "1ad703bcd0a1404aed95074b749233da44fcd94f4e021a8ac8ea2e2a99493fcf",
    "sites": [
      {
        "line": 26,
        "column": 71,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-connect-devices-client.ts",
    "sha256": "269805b59f9e211976ba35cb6bac1a17b0b4a62be837239b4214744748b7e99b",
    "sites": [
      {
        "line": 39,
        "column": 169,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-contact-groups-client.ts",
    "sha256": "117c84059fbbe3660533b05830b2437b9719f8515c07a493d14514b594d4a913",
    "sites": [
      {
        "line": 33,
        "column": 111,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 34,
        "column": 86,
        "method": "querySelector",
        "argument": "'[data-groups-' + key + ']'",
        "classification": "source-classified",
        "controllers": [
          "mail-contact-groups-controls"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-contacts-tools-client.ts",
    "sha256": "f38a83525b54338f55935764a08df64b6e2aac1be326937a2cffc1dd49d61a91",
    "sites": [
      {
        "line": 103,
        "column": 85,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-contacts-workspace-client.ts",
    "sha256": "7778240ed3d44ff666295e04254d5e1971afc73d497deae143e82fc02bd735ff",
    "sites": [
      {
        "line": 91,
        "column": 135,
        "method": "querySelector",
        "argument": "'[data-contact-'+key+']'",
        "classification": "source-classified",
        "controllers": [
          "mail-contacts-buttons"
        ]
      },
      {
        "line": 100,
        "column": 135,
        "method": "querySelector",
        "argument": "'[name='+key+']'",
        "classification": "source-classified",
        "controllers": [
          "mail-contacts-fields"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-disk-usage-client.ts",
    "sha256": "73bd601fe40639cef9e28b2ce22647b788ff5bb3992a13c57b8e8fb7f75d9822",
    "sites": [
      {
        "line": 95,
        "column": 167,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 97,
        "column": 103,
        "method": "querySelector",
        "argument": "'[data-mail-usage-fact=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-usage-facts"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-draft-client.ts",
    "sha256": "12935f157150786dc5c474cc2703609605c2d818616763a6121d841642471050",
    "sites": [
      {
        "line": 23,
        "column": 118,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-folder-workspace-client.ts",
    "sha256": "e5b1966ea7b2ca4ccb56db3d301658807fc8baa5244010b528e2426382e1043f",
    "sites": [
      {
        "line": 192,
        "column": 877,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "mail-folder-template-projections"
        ]
      },
      {
        "line": 200,
        "column": 109,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "mail-folder-template-projections"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-folders-client.ts",
    "sha256": "9b9648644572d5f248f760d00fc14b34706980453603fff135b4981da0fced91",
    "sites": [
      {
        "line": 65,
        "column": 171,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 67,
        "column": 103,
        "method": "querySelector",
        "argument": "'[data-mail-folders-fact=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-folder-facts"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-identities-client.ts",
    "sha256": "83ff05725ae5f94f806387a6cddc6a651403c7e710c9df26b4da4d78dd3f5155",
    "sites": [
      {
        "line": 106,
        "column": 85,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-mailbox-forwarders-client.ts",
    "sha256": "bf80be43242424d3a83bac9a0b10fc1c57e4a1a3eecefd1e94af033b4dc5a937",
    "sites": [
      {
        "line": 48,
        "column": 177,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-mailbox-preferences-client.ts",
    "sha256": "448d813a5260cf95d246b065069ed127e5608ffa21a92b362c9566ec1390ade2",
    "sites": [
      {
        "line": 65,
        "column": 77,
        "method": "querySelector",
        "argument": "`select[name=\"${name}\"]`",
        "classification": "source-classified",
        "controllers": [
          "mail-preferences-selects"
        ]
      },
      {
        "line": 70,
        "column": 179,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-search-client.ts",
    "sha256": "e592cf24bbaae99112375d5300b5b928506a6d11dbec69e8fb8ac4f0a6eb08a8",
    "sites": [
      {
        "line": 70,
        "column": 88,
        "method": "querySelector",
        "argument": "'[data-mail-search-' + key + ']'",
        "classification": "source-classified",
        "controllers": [
          "mail-search-detail-fields"
        ]
      },
      {
        "line": 76,
        "column": 167,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-send-client.ts",
    "sha256": "a3960c0a03e3c97cd73ca67b26ae136f63af2968c8cf4ccacbd1625504e6196d",
    "sites": [
      {
        "line": 19,
        "column": 66,
        "method": "querySelectorAll",
        "argument": "`[data-mail-chip=\"${kind}\"]`",
        "classification": "source-classified",
        "controllers": [
          "compose-recipient-chips"
        ]
      },
      {
        "line": 20,
        "column": 39,
        "method": "getElementById",
        "argument": "`compose-${kind}`",
        "classification": "source-classified",
        "controllers": [
          "compose-recipient-input-ids"
        ]
      },
      {
        "line": 104,
        "column": 49,
        "method": "getElementById",
        "argument": "id",
        "classification": "source-classified",
        "controllers": [
          "compose-clear-accepted-input-ids"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-spam-client.ts",
    "sha256": "898638e14f3aa50b5ac0a5299ec535c7b9b216d734d3f9368f363b5d3018155e",
    "sites": [
      {
        "line": 38,
        "column": 112,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-spam-fields"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-track-delivery-client.ts",
    "sha256": "95842254e7ca5098c63066ec7a0309b7e53d94d4d6e67122508118c50c23e315",
    "sites": [
      {
        "line": 67,
        "column": 165,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 69,
        "column": 103,
        "method": "querySelector",
        "argument": "'[data-mail-track-fact=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-track-facts"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mail-vacation-workspace-client.ts",
    "sha256": "95e02b49fd595c664d9b55215d09fc376e96ee5d529a5da45539111b73e5bf3b",
    "sites": [
      {
        "line": 81,
        "column": 178,
        "method": "querySelector",
        "argument": "'[data-vacation-'+key+']'",
        "classification": "source-classified",
        "controllers": [
          "mail-vacation-buttons"
        ]
      },
      {
        "line": 89,
        "column": 176,
        "method": "querySelector",
        "argument": "'[name='+key+']'",
        "classification": "source-classified",
        "controllers": [
          "mail-vacation-fields"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mailx-archive-client.ts",
    "sha256": "b21da33bd282b2303937c5ae3917f3bdf6b682f0fcc3b09a265435b539e05cb0",
    "sites": [
      {
        "line": 57,
        "column": 113,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 60,
        "column": 103,
        "method": "querySelector",
        "argument": "'[data-mailx-archive-fact=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mailx-archive-facts"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mailx-collections-client.ts",
    "sha256": "db682cf84989796bbcbdbef3afa72a8bae7c29bf2e625993a8fede22777e5813",
    "sites": [
      {
        "line": 49,
        "column": 82,
        "method": "querySelector",
        "argument": "'[data-mailx-' + key + ']'",
        "classification": "source-classified",
        "controllers": [
          "mailx-collections-controls"
        ]
      },
      {
        "line": 59,
        "column": 113,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mailx-mail-tools-client.ts",
    "sha256": "3b34237c21071e1ff843167ab37f090ef8831ce4b64f99324016e01023bb3e31",
    "sites": [
      {
        "line": 89,
        "column": 113,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 91,
        "column": 103,
        "method": "querySelector",
        "argument": "'[data-mailx-tools-fact=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mailx-list-delivery-facts"
        ]
      },
      {
        "line": 145,
        "column": 113,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 147,
        "column": 103,
        "method": "querySelector",
        "argument": "'[data-mailx-tools-fact=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mailx-spam-delivery-facts"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mailx-whm-client.ts",
    "sha256": "cac65b3fc8b7e6f3bfcfe83217933625597d69538e26c46631e7192661ba2cd3",
    "sites": [
      {
        "line": 69,
        "column": 111,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 71,
        "column": 102,
        "method": "querySelector",
        "argument": "'[data-mailx-field=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mailx-whm-bcc-fields",
          "mailx-whm-marketing-fields",
          "mailx-whm-relay-fields",
          "mailx-whm-spam-fields"
        ]
      },
      {
        "line": 79,
        "column": 112,
        "method": "querySelector",
        "argument": "'[data-mailx-fact=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mailx-whm-common-facts",
          "mailx-whm-spam-facts"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/ops-file-sharing-client.ts",
    "sha256": "7ce0606b6ce14487d0453a38cc72a76bbdc292ee2cd4d14f3046dc8a66e50fef",
    "sites": [
      {
        "line": 51,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-ops-shares-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-file-sharing-dynamic-48"
        ]
      },
      {
        "line": 56,
        "column": 147,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 70,
        "column": 105,
        "method": "querySelector",
        "argument": "'[data-ops-shares-fact=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-file-sharing-dynamic-57"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/ops-integrations-client.ts",
    "sha256": "d52891e8f05db9f547cb77961950eb893bade08b5f7ef093ba87db4fa97d4a9f",
    "sites": [
      {
        "line": 51,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-ops-int-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-integrations-dynamic-48"
        ]
      },
      {
        "line": 55,
        "column": 144,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 73,
        "column": 105,
        "method": "querySelector",
        "argument": "'[data-ops-int-fact=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-integrations-dynamic-56"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/ops-nodes-client.ts",
    "sha256": "66a52b6f862bc971c1135f383611a926ef2f08940eea5c487482b364bcc89437",
    "sites": [
      {
        "line": 39,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-ops-nodes-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-nodes-dynamic-36"
        ]
      },
      {
        "line": 40,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-ops-nodes-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-nodes-dynamic-37"
        ]
      },
      {
        "line": 45,
        "column": 146,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 60,
        "column": 105,
        "method": "querySelector",
        "argument": "'[data-ops-nodes-fact=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-nodes-dynamic-47"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/ops-terminal-client.ts",
    "sha256": "cad35c42ea8175bf3201538447a5f4755df2d9f593805709fd33c512031103b2",
    "sites": [
      {
        "line": 50,
        "column": 102,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "ops-terminal-forwarded"
        ]
      },
      {
        "line": 62,
        "column": 183,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/panel-handoff-client.ts",
    "sha256": "34db7c577101c7e274cb83388a28a159399bad3fca96406d27ea43cc00c6cd39",
    "sites": [
      {
        "line": 70,
        "column": 49,
        "method": "getElementById",
        "argument": "id",
        "classification": "source-classified",
        "controllers": [
          "handoff-mailbox-select-id"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/password-generate-client.ts",
    "sha256": "ba6972400e5b602cf936624e7fc7db2a3affebc18fd5cf9ba53fef1b2fd95095",
    "sites": [
      {
        "line": 37,
        "column": 78,
        "method": "getElementById",
        "argument": "button.dataset.passwordTarget",
        "classification": "source-classified",
        "controllers": [
          "account-password-reveal-target"
        ]
      },
      {
        "line": 38,
        "column": 54,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 38,
        "column": 319,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 53,
        "column": 52,
        "method": "closest",
        "argument": "accountCreation ? 'form[data-create-account-form]' : 'form[data-mailbox-form]'",
        "classification": "finite-owning-form-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 54,
        "column": 54,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 56,
        "column": 57,
        "method": "getElementById",
        "argument": "targetId",
        "classification": "source-classified",
        "controllers": [
          "generated-password-target"
        ]
      },
      {
        "line": 57,
        "column": 218,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 58,
        "column": 54,
        "method": "querySelector",
        "argument": "accountCreation ? '[data-account-create-status]' : '[data-mailbox-status]'",
        "classification": "source-classified",
        "controllers": [
          "password-generator-status-projections"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/sec-security-client.ts",
    "sha256": "694860e75c82e3bbc9c04a975d412d6ce864b13904150d9227289c69748684af",
    "sites": [
      {
        "line": 45,
        "column": 100,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "sec-kit-account-cloudflare",
          "sec-kit-account-waf",
          "sec-kit-dns-cluster",
          "sec-kit-dns-providers",
          "sec-kit-flood",
          "sec-kit-panel-access",
          "sec-kit-waf"
        ]
      },
      {
        "line": 46,
        "column": 104,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "sec-kit-account-cloudflare",
          "sec-kit-account-waf",
          "sec-kit-dns-cluster",
          "sec-kit-dns-providers",
          "sec-kit-flood",
          "sec-kit-panel-access",
          "sec-kit-waf"
        ]
      },
      {
        "line": 51,
        "column": 128,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/site-health-client.ts",
    "sha256": "6750958048f2087013e35191db35e3dff692d9ecfa3d5929bb48862d389e6e84",
    "sites": [
      {
        "line": 56,
        "column": 83,
        "method": "querySelector",
        "argument": "'[data-health-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "site-health"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/sw-addon-services-client.ts",
    "sha256": "6eeaa45561cc196df33876f43e3335cede63b399999bac7daef81d3c280db606",
    "sites": [
      {
        "line": 34,
        "column": 108,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/sw-app-projects-client.ts",
    "sha256": "bae564cb0cc1037044088755c2fe4d1d8b49ba3deeac06651df07ca5f22d27a1",
    "sites": [
      {
        "line": 40,
        "column": 108,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/sw-applications-client.ts",
    "sha256": "b1a846666459db4f80603678cb6007a0436cd069259f8c03c801c64eb158ffd9",
    "sites": [
      {
        "line": 18,
        "column": 92,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "sw-applications-forwarded"
        ]
      },
      {
        "line": 21,
        "column": 110,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/sw-containers-client.ts",
    "sha256": "82d498ad2373132f4f88411e6078d1536ce7e163fca42ba3842123811cdbf3bb",
    "sites": [
      {
        "line": 26,
        "column": 108,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 114,
        "column": 145,
        "method": "querySelector",
        "argument": "'tbody[data-sw-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "sw-containers-dynamic-114"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/sw-deployments-client.ts",
    "sha256": "ef721cee5329016249c2d84ba4132265e15b6387d91acc1d4d11e4427f45df0a",
    "sites": [
      {
        "line": 46,
        "column": 87,
        "method": "querySelector",
        "argument": "'[data-sw-dep-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "sw-deployments-dynamic-43"
        ]
      },
      {
        "line": 50,
        "column": 108,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/sw-optimize-client.ts",
    "sha256": "b5309a4c0f0bc0d448a6efce89e963f555a409c5ea058e702418272024203c0b",
    "sites": [
      {
        "line": 19,
        "column": 108,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 21,
        "column": 118,
        "method": "querySelector",
        "argument": "'[data-sw-optimize-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "sw-optimize-dynamic-18"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-account-health-client.ts",
    "sha256": "9c4cc869b12a17a4cf6762e6617efdc76fd3fc4a8d046bd1199b60ff1aa09ce6",
    "sites": [
      {
        "line": 74,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-health-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-account-health-dynamic-71"
        ]
      },
      {
        "line": 80,
        "column": 147,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 231,
        "column": 115,
        "method": "querySelector",
        "argument": "'[data-whm-health-account=\"' + account.username + '\"]'",
        "classification": "runtime-generated-optional",
        "controllers": [
          "whm-account-health-dynamic-224"
        ]
      },
      {
        "line": 273,
        "column": 137,
        "method": "querySelector",
        "argument": "'[data-whm-health-account=\"' + name + '\"]'",
        "classification": "runtime-generated-optional",
        "controllers": [
          "whm-account-health-dynamic-266"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-announcements-client.ts",
    "sha256": "7fd2240d8a9e3ecf38cf6c903fbf5001f3d16a7b6d806fdc25f08010ae943d28",
    "sites": [
      {
        "line": 70,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-announcements-forwarded"
        ]
      },
      {
        "line": 82,
        "column": 128,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-backup-destinations-client.ts",
    "sha256": "9a48acd3e719770ac078bb59e4e6f413c0b818ee8e7f3eab301cec5d0b9e08c1",
    "sites": [
      {
        "line": 89,
        "column": 118,
        "method": "querySelector",
        "argument": "'[data-destination-field=\"'+name+'\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backup-destinations-dynamic-43"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-backup-files-client.ts",
    "sha256": "20e10219c080d9dacd9a17bf867e65b5b234917bd8a746d602e384e3cd9cf9f3",
    "sites": [
      {
        "line": 83,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-backup-files-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backup-files-dynamic-80"
        ]
      },
      {
        "line": 90,
        "column": 152,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 96,
        "column": 30,
        "method": "matches",
        "argument": "selector",
        "classification": "finite-exact-template-slot",
        "controllers": [
          "whm-backup-files-dynamic-80"
        ]
      },
      {
        "line": 96,
        "column": 79,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-exact-template-slot",
        "controllers": [
          "whm-backup-files-dynamic-80"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-backups-client.ts",
    "sha256": "47b6b9ede657ca0d8785a76e33e56dfec59dc931e6bac37111ef5b44790a4835",
    "sites": [
      {
        "line": 149,
        "column": 91,
        "method": "querySelector",
        "argument": "'#backup-layout-' + key",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backups-dynamic-104"
        ]
      },
      {
        "line": 150,
        "column": 94,
        "method": "querySelector",
        "argument": "'#backup-layout-' + key",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backups-dynamic-105"
        ]
      },
      {
        "line": 151,
        "column": 94,
        "method": "querySelector",
        "argument": "'[data-backup-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backups-dynamic-106"
        ]
      },
      {
        "line": 153,
        "column": 111,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 430,
        "column": 111,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 433,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-backups-forwarded"
        ]
      },
      {
        "line": 434,
        "column": 104,
        "method": "querySelectorAll",
        "argument": "'[data-backup-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backups-dynamic-371"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-composer-client.ts",
    "sha256": "a9006c9c7301a2720bcf7a274b0c4914e6d1700c956774dc1c716ce624e11206",
    "sites": [
      {
        "line": 25,
        "column": 114,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 32,
        "column": 118,
        "method": "querySelector",
        "argument": "'[data-composer-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-composer-dynamic-29"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-configuration-health-client.ts",
    "sha256": "a8ad0abc39183d75a5fc59dd845d0b179eae25765eee9cb95ac9f6c9b1ced80f",
    "sites": [
      {
        "line": 15,
        "column": 78,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-configuration-health-forwarded"
        ]
      },
      {
        "line": 20,
        "column": 132,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-database-tuning-client.ts",
    "sha256": "dc56385b8b75ce530a5bf1704bc399b28f373a9094591153457ef42787d1637c",
    "sites": [
      {
        "line": 93,
        "column": 137,
        "method": "querySelector",
        "argument": "'[data-db-tuning-fact=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-database-tuning-dynamic-87"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-databases-client.ts",
    "sha256": "7e7f8d77f8294f080b67cd4a0984bc1e5596719bb2207ab79c2e62142745710c",
    "sites": [
      {
        "line": 127,
        "column": 108,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 140,
        "column": 54,
        "method": "querySelector",
        "argument": "'[data-whm-db-fact=\"' + key + '\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-databases-dynamic-136"
        ]
      },
      {
        "line": 147,
        "column": 81,
        "method": "querySelector",
        "argument": "'[data-whm-db-rows=\"'+name+'\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-databases-dynamic-143"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-developer-client.ts",
    "sha256": "3426a3d1d44c88e1694c045740ee72e12e688405a238b3b34ff8e5bc0a8c0310",
    "sites": [
      {
        "line": 56,
        "column": 95,
        "method": "querySelector",
        "argument": "s",
        "classification": "source-classified",
        "controllers": [
          "whm-developer-forwarded"
        ]
      },
      {
        "line": 74,
        "column": 142,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-dns-client.ts",
    "sha256": "0443683b4363702780074f05c65a56a92a3a34300a2aeba8df6d38cc3b3e0dcf",
    "sites": [
      {
        "line": 27,
        "column": 94,
        "method": "querySelector",
        "argument": "'[data-dns-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-dns-dynamic-23"
        ]
      },
      {
        "line": 34,
        "column": 71,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-dns-tools-client.ts",
    "sha256": "a3aac0a48e9bd85a48fd9c4b902e91babbcc2b013a7a01223b9289210ab1decb",
    "sites": [
      {
        "line": 117,
        "column": 102,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-dns-tools-forwarded"
        ]
      },
      {
        "line": 123,
        "column": 114,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 166,
        "column": 106,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-dns-tools-forwarded"
        ]
      },
      {
        "line": 172,
        "column": 50,
        "method": "querySelectorAll",
        "argument": "'[data-whm-dns-tools-page=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-dns-tools-dynamic-166"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-domains-client.ts",
    "sha256": "13b4a05e0979c73f001c0844534c6745874d6bfab0373df40280e5f440ab0ae1",
    "sites": [
      {
        "line": 54,
        "column": 95,
        "method": "querySelector",
        "argument": "'[data-whm-domain-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-domains-dynamic-54"
        ]
      },
      {
        "line": 55,
        "column": 138,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-domains-dynamic-55"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-firewall-client.ts",
    "sha256": "56327803ac0f8e8e34741e9f5eb7532b4afd1f8e22ac5381854bfe6aca69583f",
    "sites": [
      {
        "line": 151,
        "column": 60,
        "method": "querySelector",
        "argument": "'[data-whm-firewall-panel=\"' + kind + '\"] table'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-firewall-dynamic-117"
        ]
      },
      {
        "line": 202,
        "column": 150,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-firewall-dynamic-164"
        ]
      },
      {
        "line": 210,
        "column": 68,
        "method": "querySelector",
        "argument": "'[data-firewall-action=\"' + hookName + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-firewall-dynamic-172"
        ]
      },
      {
        "line": 213,
        "column": 206,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-firewall-dynamic-175"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-ftp-log-client.ts",
    "sha256": "dfd0f13fa7eda365bb044138f01e88e781a8c998ac404fb25cb4fa33931c1904",
    "sites": [
      {
        "line": 117,
        "column": 138,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 118,
        "column": 103,
        "method": "querySelector",
        "argument": "'[data-ftp-log-fact=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-ftp-log-dynamic-115"
        ]
      },
      {
        "line": 137,
        "column": 64,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "whm-ftp-log-workspace-controls"
        ]
      },
      {
        "line": 157,
        "column": 52,
        "method": "querySelector",
        "argument": "'[data-ftp-log-table=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-ftp-log-dynamic-137"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-ips-client.ts",
    "sha256": "ec0729de6e4f63e6fe71b316aa177fcb087ccdfdea2d78c73eb20737815e6abc",
    "sites": [
      {
        "line": 63,
        "column": 109,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-jobs-client.ts",
    "sha256": "57ea1089d31a3cd10fac9d080f7b52103f86209d8ebd1da9c1b00ed251d041e3",
    "sites": [
      {
        "line": 72,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-jobs-forwarded"
        ]
      },
      {
        "line": 106,
        "column": 137,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 146,
        "column": 115,
        "method": "querySelector",
        "argument": "'[data-whm-jobs-field=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-jobs-dynamic-119"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-languages-client.ts",
    "sha256": "4d8ba5c8cc925e8f59b1e7462beaf87532f342490cb1b6e9c975e088fbe5522c",
    "sites": [
      {
        "line": 46,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-languages-forwarded"
        ]
      },
      {
        "line": 47,
        "column": 92,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-languages-forwarded"
        ]
      },
      {
        "line": 55,
        "column": 144,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-mail-log-client.ts",
    "sha256": "b15f678d873bdcf6b27812df93e1ab9b2a7ae52b0f2aec52c702425b1f9f9434",
    "sites": [
      {
        "line": 133,
        "column": 140,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 141,
        "column": 103,
        "method": "querySelector",
        "argument": "'[data-mail-log-fact=\"' + key + '\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-mail-log-dynamic-118"
        ]
      },
      {
        "line": 215,
        "column": 54,
        "method": "querySelector",
        "argument": "'[data-mail-monitor-table=\"' + key + '\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-mail-log-dynamic-192"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-mail-quality-client.ts",
    "sha256": "d3bd987f6c920e25f3a9fb73ddfbc6e8c42aa60882c026ad16b216b94985f896",
    "sites": [
      {
        "line": 97,
        "column": 144,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 132,
        "column": 103,
        "method": "querySelector",
        "argument": "'[data-whm-mail-quality-fact=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-mail-quality-dynamic-109"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-mail-queue-client.ts",
    "sha256": "7b99e82cdcb22d73ce688532a96c8363a584a60e14c648c14ad7e34be48f0b9d",
    "sites": [
      {
        "line": 61,
        "column": 95,
        "method": "querySelector",
        "argument": "'[data-whm-mail-queue-filter=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-mail-queue-dynamic-58"
        ]
      },
      {
        "line": 82,
        "column": 142,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 119,
        "column": 93,
        "method": "querySelector",
        "argument": "'[data-whm-mail-queue-count=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-mail-queue-dynamic-92"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-mail-server-client.ts",
    "sha256": "40ae02c79008efab6133f71f15496576d126dc6a4150abac8f6ac5f0a42b4c46",
    "sites": [
      {
        "line": 113,
        "column": 143,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 130,
        "column": 88,
        "method": "querySelector",
        "argument": "'[data-whm-mail-server-' + name + ']'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-mail-server-dynamic-107"
        ]
      },
      {
        "line": 144,
        "column": 105,
        "method": "querySelector",
        "argument": "'[data-whm-mail-server-fact=\"' + key + '\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-mail-server-dynamic-121"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-mailbox-maintenance-client.ts",
    "sha256": "45e42e793943c412b00e3306b94daabdfe637a1e36adafac2e6cbc057572da3c",
    "sites": [
      {
        "line": 69,
        "column": 102,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-mailbox-maintenance-forwarded"
        ]
      },
      {
        "line": 88,
        "column": 151,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-metering-client.ts",
    "sha256": "5600938ceac06c887cd86f89230e0e87f3c87214b64953819dc8eedf57f806cb",
    "sites": [
      {
        "line": 58,
        "column": 90,
        "method": "querySelector",
        "argument": "'[data-whm-metering-fact=\"' + key + '\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-metering-dynamic-58"
        ]
      },
      {
        "line": 60,
        "column": 52,
        "method": "querySelector",
        "argument": "'[data-whm-metering-rows=\"' + table + '\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-metering-dynamic-60"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-monitoring-alerts-client.ts",
    "sha256": "13ed467c9280e0b4758e8b0947abe361751205a96971e2f1b5dc6590957baad6",
    "sites": [
      {
        "line": 118,
        "column": 104,
        "method": "querySelector",
        "argument": "'[data-whm-alerts-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-monitoring-alerts-dynamic-112"
        ]
      },
      {
        "line": 125,
        "column": 108,
        "method": "querySelector",
        "argument": "'[data-whm-alerts-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-monitoring-alerts-dynamic-119"
        ]
      },
      {
        "line": 128,
        "column": 114,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 138,
        "column": 114,
        "method": "querySelector",
        "argument": "'[data-whm-alerts-fact=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-monitoring-alerts-dynamic-128"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-monitoring-client.ts",
    "sha256": "175c687392f242a773ebc17a9d50ed92ace99f866237b7211d4b3931e5d1a918",
    "sites": [
      {
        "line": 135,
        "column": 178,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 138,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-monitoring-' + name + ']'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-monitoring-dynamic-118"
        ]
      },
      {
        "line": 366,
        "column": 44,
        "method": "querySelector",
        "argument": "'[data-whm-monitoring-chart=\"' + metric + '\"] figcaption'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-monitoring-dynamic-340"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-panel-branding-client.ts",
    "sha256": "e6db4d0cfa369d266c808919f9e5c2f942dee06e3d5322af93a9192b501c42d6",
    "sites": [
      {
        "line": 36,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-panel-branding-forwarded"
        ]
      },
      {
        "line": 44,
        "column": 116,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-panel-data-client.ts",
    "sha256": "bcbb03de5399deec66a92f0179b5348123476f611912b0a75f19001e07233414",
    "sites": [
      {
        "line": 42,
        "column": 145,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-panel-notifications-client.ts",
    "sha256": "801793a6e7a80b436da13a24e69e9e1057798e79352ecdb13ad189e0abea2d3e",
    "sites": [
      {
        "line": 60,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-panel-notifications-forwarded"
        ]
      },
      {
        "line": 83,
        "column": 148,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 94,
        "column": 100,
        "method": "querySelector",
        "argument": "'[data-whm-notifications-field=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-panel-notifications-dynamic-71"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-panel-settings-client.ts",
    "sha256": "104c8b82bba5bed8886bb15c370253ef885663951a3876bb76eca106d4d0478b",
    "sites": [
      {
        "line": 30,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-panel-settings-forwarded"
        ]
      },
      {
        "line": 39,
        "column": 121,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-panel-tokens-client.ts",
    "sha256": "3052061f24ca6c3cfb7539ca0a13f06ec065cdb3ae64d7c32cab2f3f460e0de2",
    "sites": [
      {
        "line": 56,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-panel-tokens-forwarded"
        ]
      },
      {
        "line": 85,
        "column": 141,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-php-client.ts",
    "sha256": "609a5d42027b5212b969ae687255f984212c1537c3c7d691a969d85ecd2cde7a",
    "sites": [
      {
        "line": 93,
        "column": 126,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 98,
        "column": 102,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-91"
        ]
      },
      {
        "line": 111,
        "column": 64,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "whm-php-workspace-controls"
        ]
      },
      {
        "line": 134,
        "column": 288,
        "method": "querySelectorAll",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-91",
          "whm-php-dynamic-201",
          "whm-php-dynamic-248",
          "whm-php-dynamic-276",
          "whm-php-workspace-controls"
        ]
      },
      {
        "line": 135,
        "column": 228,
        "method": "querySelectorAll",
        "argument": "'[data-php-action=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-141"
        ]
      },
      {
        "line": 268,
        "column": 100,
        "method": "querySelector",
        "argument": "'[data-php-action=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-141"
        ]
      },
      {
        "line": 272,
        "column": 52,
        "method": "querySelector",
        "argument": "'[data-whm-detail-section=\"' + section + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-144"
        ]
      },
      {
        "line": 331,
        "column": 186,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-201",
          "whm-php-dynamic-248"
        ]
      },
      {
        "line": 336,
        "column": 91,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-201",
          "whm-php-dynamic-248"
        ]
      },
      {
        "line": 430,
        "column": 91,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-201",
          "whm-php-dynamic-248"
        ]
      },
      {
        "line": 457,
        "column": 176,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-276"
        ]
      },
      {
        "line": 463,
        "column": 95,
        "method": "querySelector",
        "argument": "'[name=\"php-exception-' + fn + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-282"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-preferences-client.ts",
    "sha256": "c88897beca8bddfc281c4874e4b1ae03959188da37a00baa15327e272741412d",
    "sites": [
      {
        "line": 31,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-preferences-forwarded"
        ]
      },
      {
        "line": 38,
        "column": 146,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-repair-client.ts",
    "sha256": "bbf7709f91b18a29ae04c69b2f73304507d58c00b26f8f9fb48e0b81b710ef3e",
    "sites": [
      {
        "line": 87,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-repair-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-repair-dynamic-84"
        ]
      },
      {
        "line": 93,
        "column": 147,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-security-tools-client.ts",
    "sha256": "35671e92bc36f4202202749f9a107ee9dabd3e48f628361314b101e55058cca7",
    "sites": [
      {
        "line": 103,
        "column": 102,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "security-tools-antivirus",
          "security-tools-intrusion",
          "security-tools-isolation"
        ]
      },
      {
        "line": 109,
        "column": 145,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-server-health-client.ts",
    "sha256": "e9ea88389b2cce19b478f4dd961eedf185f52cd75adc989f745098f385172730",
    "sites": [
      {
        "line": 119,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-server-health-' + name + ']'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-server-health-dynamic-116"
        ]
      },
      {
        "line": 129,
        "column": 153,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 316,
        "column": 88,
        "method": "querySelector",
        "argument": "'[data-whm-server-health-account=\"' + account.username + '\"]'",
        "classification": "runtime-generated-optional",
        "controllers": [
          "whm-server-health-dynamic-299"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-server-observation-client.ts",
    "sha256": "054d70b74d19449e25b7e86aef34f9bcb77806f2d514c5be7274317502867ce7",
    "sites": [
      {
        "line": 109,
        "column": 158,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 116,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-server-observation-' + name + ']'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-server-observation-dynamic-116"
        ]
      },
      {
        "line": 117,
        "column": 90,
        "method": "querySelector",
        "argument": "'[data-whm-server-observation-' + marker + ']'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-server-observation-dynamic-117"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-service-detail-client.ts",
    "sha256": "7be967c8d349e1ea4e7bde2e150f28ceece38be3bd46bde1960f43ce39f0b635",
    "sites": [
      {
        "line": 105,
        "column": 145,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 131,
        "column": 110,
        "method": "querySelector",
        "argument": "'[data-whm-service-detail-fact=\"' + key + '\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-service-detail-dynamic-108"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-service-manager-client.ts",
    "sha256": "146349cbf9277940b805e2db9ded2603fe51c3db354a6ec663e6a673ad8482e1",
    "sites": [
      {
        "line": 49,
        "column": 88,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-service-manager-forwarded"
        ]
      },
      {
        "line": 55,
        "column": 157,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-software-center-client.ts",
    "sha256": "c8818a0e823c6d6973a1bf01aae9c5dae8666c2669592d4d9451e1e7e8a91d0c",
    "sites": [
      {
        "line": 79,
        "column": 88,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-software-center-forwarded"
        ]
      },
      {
        "line": 93,
        "column": 143,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-ssl-client.ts",
    "sha256": "7f20b44e8733eaad7aa1fa8be39cfcbc6fdfbd346d87ab7d1b374300248592ee",
    "sites": [
      {
        "line": 79,
        "column": 86,
        "method": "querySelector",
        "argument": "'[data-ssl-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-ssl-dynamic-75"
        ]
      },
      {
        "line": 89,
        "column": 111,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-ssl-install-client.ts",
    "sha256": "72693afdf964d75cc6fe0ae687633769b676237c2bb9ca0ea38e94390005a5a1",
    "sites": [
      {
        "line": 112,
        "column": 86,
        "method": "querySelector",
        "argument": "'[data-ssl-install-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-ssl-install-dynamic-108"
        ]
      },
      {
        "line": 120,
        "column": 118,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-ssl-observations-client.ts",
    "sha256": "ca05af6dd93668adc824375f19b7f77d9454231c8877923d08a842191398c896",
    "sites": [
      {
        "line": 70,
        "column": 133,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-ssl-observations-forwarded"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-support-client.ts",
    "sha256": "b83cbcba4df2a869b27ce046047adb7d414836ff0947ea15b5bb1aba1ee1b7b9",
    "sites": [
      {
        "line": 85,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-support-forwarded"
        ]
      },
      {
        "line": 104,
        "column": 140,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 116,
        "column": 86,
        "method": "querySelector",
        "argument": "'[data-whm-support-fact=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-support-dynamic-93"
        ]
      },
      {
        "line": 119,
        "column": 39,
        "method": "querySelector",
        "argument": "'[data-whm-support-' + marker + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-support-dynamic-96"
        ]
      },
      {
        "line": 157,
        "column": 28,
        "method": "querySelector",
        "argument": "'[data-whm-support-' + marker + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-support-dynamic-134"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-traffic-client.ts",
    "sha256": "3f9650c27f594bd1b807cee057d3ed311668c4c7e29fcb4240a2ed9ea5fb6dc2",
    "sites": [
      {
        "line": 35,
        "column": 64,
        "method": "querySelector",
        "argument": "'[data-traffic-table=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-traffic-dynamic-35"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-transfer-client.ts",
    "sha256": "de5ac68a16d87cb62cd5365c5ba711843d14cf140e214167a43d4885584b2fb0",
    "sites": [
      {
        "line": 36,
        "column": 90,
        "method": "querySelector",
        "argument": "'[data-transfer-field=\"' + id + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-transfer-dynamic-28"
        ]
      },
      {
        "line": 37,
        "column": 95,
        "method": "querySelector",
        "argument": "'[data-transfer-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-transfer-dynamic-29"
        ]
      },
      {
        "line": 65,
        "column": 131,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 100,
        "column": 64,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "whm-transfer-dynamic-28",
          "whm-transfer-dynamic-29",
          "whm-transfer-workspace-controls"
        ]
      },
      {
        "line": 255,
        "column": 65,
        "method": "querySelector",
        "argument": "`[data-transfer-import-${key}]`",
        "classification": "finite-owning-page-projection",
        "controllers": [
          "whm-transfer-import-projections"
        ]
      },
      {
        "line": 255,
        "column": 125,
        "method": "querySelector",
        "argument": "`[data-transfer-import-part=\"${key}\"] tbody`",
        "classification": "finite-owning-page-projection",
        "controllers": [
          "whm-transfer-import-projections"
        ]
      },
      {
        "line": 333,
        "column": 41,
        "method": "querySelector",
        "argument": "'[' + hook + ']'",
        "classification": "finite-owning-page-projection",
        "controllers": [
          "whm-transfer-dynamic-213"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-trusted-proxies-client.ts",
    "sha256": "a953a9955d8c02c9a8b17ff563e8ea3686aebdd8d6062ff7dc509b656e2f3b2c",
    "sites": [
      {
        "line": 36,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-trusted-proxies-forwarded"
        ]
      },
      {
        "line": 42,
        "column": 149,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-updates-client.ts",
    "sha256": "ae1deb1f26b29427867e28f7688c3cb6a9d087c95a231517b857ded541e09ce6",
    "sites": [
      {
        "line": 61,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-whm-updates-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-updates-dynamic-58"
        ]
      },
      {
        "line": 65,
        "column": 148,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 85,
        "column": 105,
        "method": "querySelector",
        "argument": "'[data-whm-updates-fact=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-updates-dynamic-83"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-upgrade-client.ts",
    "sha256": "3487728b94ab4c52ac0c620f291def63e5bcea4fc9aca1edbf6858d570694a2f",
    "sites": [
      {
        "line": 175,
        "column": 92,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-upgrade-forwarded"
        ]
      },
      {
        "line": 181,
        "column": 115,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-web-server-client.ts",
    "sha256": "60185e11e9e1cfe6688610b5397d3a27c41f5cc940cc1358b109d9fb5502bfc7",
    "sites": [
      {
        "line": 85,
        "column": 100,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-whmcs-client.ts",
    "sha256": "c5f785e04002080e1fb5a34f6fb94d02c41907cd0d30b5d820d0ca74d3c2282b",
    "sites": [
      {
        "line": 65,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-whmcs-forwarded"
        ]
      },
      {
        "line": 80,
        "column": 166,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/ws-client.ts",
    "sha256": "90c7d0502ec2fc693061510616bdd85522cbcba906cd93f476464913c51cb9ad",
    "sites": [
      {
        "line": 640,
        "column": 41,
        "method": "querySelector",
        "argument": "'[data-stage=\"' + event.data.stage + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "reconcile-stage-projections"
        ]
      },
      {
        "line": 833,
        "column": 51,
        "method": "getElementById",
        "argument": "routeOrId.slice(1)",
        "classification": "source-classified",
        "controllers": [
          "shared-hash-navigation-id"
        ]
      },
      {
        "line": 890,
        "column": 69,
        "method": "querySelectorAll",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "account-creation-optional-selection"
        ]
      },
      {
        "line": 1061,
        "column": 63,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "account-creation-required-values"
        ]
      },
      {
        "line": 1288,
        "column": 77,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "userdata-config-fields"
        ]
      },
      {
        "line": 1616,
        "column": 43,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "mailbox-password-dialog-field",
          "mailbox-quota-dialog-field"
        ]
      },
      {
        "line": 1617,
        "column": 44,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mailbox-password-dialog-field",
          "mailbox-quota-dialog-field"
        ]
      },
      {
        "line": 1657,
        "column": 43,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "tool-dialog-root-forwarder"
        ]
      },
      {
        "line": 1775,
        "column": 86,
        "method": "querySelector",
        "argument": "'[name=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-ip-config-fields"
        ]
      },
      {
        "line": 1779,
        "column": 72,
        "method": "querySelector",
        "argument": "'[name=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-ip-config-fields"
        ]
      },
      {
        "line": 1834,
        "column": 60,
        "method": "querySelector",
        "argument": "'[name=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-ip-config-fields"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mobile-navigation-client.ts",
    "sha256": "7de15c597f1f5f8f475db416dc7321eb990cfca9fdac7abdf070224771be2ce7",
    "sites": [
      {
        "line": 24,
        "column": 65,
        "method": "querySelectorAll",
        "argument": "focusableSelector",
        "classification": "source-classified",
        "controllers": [
          "overlay-focus-policy"
        ]
      },
      {
        "line": 55,
        "column": 36,
        "method": "matches",
        "argument": "focusableSelector",
        "classification": "source-classified",
        "controllers": [
          "shared-focus-selector-match"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/home-tools-client.ts",
    "sha256": "feae25fa74325b0373d72328dd5dd321e0c4d4ba33675f0eeae847bbd6528e05",
    "sites": [
      {
        "line": 21,
        "column": 80,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-unique-owned-controls",
        "controllers": [
          "panel-home-tools"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/ui-theme-client.ts",
    "sha256": "4ca2c4c6b8a8e0a66dacf4d70bba23f4e4b64007a8a3fdda6ac3b6bb31a432e8",
    "sites": [
      {
        "line": 41,
        "column": 46,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-unique-required-controls",
        "controllers": [
          "ui-theme-preferences"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/client-templates.ts",
    "sha256": "4f37ecbd4cb4f2bc6b99898a1553122585610946dc6475d0e67fffaae9e7bb06",
    "sites": [
      {
        "line": 6,
        "column": 62,
        "method": "querySelectorAll",
        "argument": "`template[data-xp-template=\"${name}\"]`",
        "classification": "validated-workspace-template-lookup",
        "controllers": [
          "account-backup",
          "account-cron",
          "account-database-insights",
          "account-database-remote",
          "account-dynamic-dns",
          "account-filters",
          "account-forwarders",
          "account-forwarders:variants:1",
          "account-forwarders:variants:2",
          "account-git",
          "account-htaccess",
          "account-logs",
          "account-mailing-lists",
          "account-network-tools",
          "account-packages",
          "account-pgp",
          "account-quarantine",
          "account-reverse-proxy",
          "account-sessions",
          "account-site-publisher",
          "account-ssh",
          "account-ssl",
          "account-virus-scan",
          "account-web-directives",
          "acct-backup-runs",
          "acct-convert-addon",
          "acct-enhancements",
          "acct-restore",
          "acct-staging",
          "acct-team",
          "acct-templates",
          "acct-transfer-credentials",
          "approved-host-services",
          "database-workspace",
          "db-engines",
          "directory-privacy",
          "domain-create-fields",
          "domain-workspace-buttons",
          "file-workspace-browse",
          "file-workspace-trash",
          "handoff-mailbox-select-id",
          "mail-attachments-mounted-reading-root",
          "mail-attachments-root",
          "mail-calendar-controls",
          "mail-calendar-day-focus",
          "mail-calendar-view-controls",
          "mail-compose-attachments-root",
          "mail-contacts-buttons",
          "mail-contacts-fields",
          "mail-contacts-tools-root",
          "mail-folder-facts",
          "mail-folder-template-projections",
          "mail-identities-root",
          "mail-mailbox-forwarders-root",
          "mail-mailing-lists-root",
          "mail-preferences-selects",
          "mail-search-detail-fields",
          "mail-track-facts",
          "mail-vacation-buttons",
          "mail-vacation-fields",
          "mailx-archive-facts",
          "mailx-collections-controls",
          "mailx-list-delivery-facts",
          "mailx-spam-delivery-facts",
          "ops-file-sharing-dynamic-48",
          "ops-file-sharing-dynamic-57",
          "ops-integrations-dynamic-48",
          "ops-integrations-dynamic-56",
          "ops-nodes-dynamic-36",
          "ops-nodes-dynamic-37",
          "ops-nodes-dynamic-47",
          "site-health",
          "sw-addon-services",
          "sw-app-projects",
          "sw-containers-dynamic-114",
          "sw-containers-list",
          "sw-deployments-dynamic-43",
          "sw-optimize-dynamic-18",
          "whm-account-health-dynamic-224",
          "whm-account-health-dynamic-266",
          "whm-account-health-dynamic-71",
          "whm-announcements-forwarded",
          "whm-backup-destinations-dynamic-43",
          "whm-backup-files-dynamic-80",
          "whm-backups-dynamic-104",
          "whm-backups-dynamic-105",
          "whm-backups-dynamic-106",
          "whm-backups-dynamic-371",
          "whm-backups-forwarded",
          "whm-composer-dynamic-29",
          "whm-database-tuning-dynamic-87",
          "whm-databases-dynamic-136",
          "whm-databases-dynamic-143",
          "whm-developer-forwarded",
          "whm-dns-dynamic-23",
          "whm-dns-tools-dynamic-166",
          "whm-dns-tools-forwarded",
          "whm-firewall-dynamic-117",
          "whm-firewall-dynamic-164",
          "whm-firewall-dynamic-172",
          "whm-firewall-dynamic-175",
          "whm-ips",
          "whm-jobs-dynamic-119",
          "whm-jobs-forwarded",
          "whm-local-archives",
          "whm-mail-log-dynamic-118",
          "whm-mail-log-dynamic-192",
          "whm-mail-quality-dynamic-109",
          "whm-mail-queue-dynamic-58",
          "whm-mail-queue-dynamic-92",
          "whm-mail-server-dynamic-107",
          "whm-mail-server-dynamic-121",
          "whm-mailbox-maintenance-forwarded",
          "whm-monitoring-alerts-dynamic-112",
          "whm-monitoring-alerts-dynamic-119",
          "whm-monitoring-alerts-dynamic-128",
          "whm-monitoring-dynamic-118",
          "whm-monitoring-dynamic-340",
          "whm-panel-data",
          "whm-panel-notifications-dynamic-71",
          "whm-panel-notifications-forwarded",
          "whm-panel-tokens-forwarded",
          "whm-repair-dynamic-84",
          "whm-server-health-dynamic-116",
          "whm-server-health-dynamic-299",
          "whm-service-manager-forwarded",
          "whm-software-center-forwarded",
          "whm-ssl-dynamic-75",
          "whm-ssl-install-dynamic-108",
          "whm-ssl-observations-forwarded",
          "whm-support-dynamic-134",
          "whm-support-dynamic-93",
          "whm-support-dynamic-96",
          "whm-support-forwarded",
          "whm-transfer-dynamic-213",
          "whm-transfer-dynamic-28",
          "whm-transfer-dynamic-29",
          "whm-transfer-import-projections",
          "whm-updates-dynamic-58",
          "whm-updates-dynamic-83",
          "zone-editor"
        ]
      },
      {
        "line": 15,
        "column": 37,
        "method": "matches",
        "argument": "selector",
        "classification": "validated-unique-clone-slot",
        "controllers": [
          "account-backup",
          "account-cron",
          "account-database-insights",
          "account-database-remote",
          "account-dynamic-dns",
          "account-filters",
          "account-forwarders",
          "account-forwarders:variants:1",
          "account-forwarders:variants:2",
          "account-git",
          "account-htaccess",
          "account-logs",
          "account-mailing-lists",
          "account-network-tools",
          "account-packages",
          "account-pgp",
          "account-quarantine",
          "account-reverse-proxy",
          "account-runtime",
          "account-sessions",
          "account-site-publisher",
          "account-ssh",
          "account-ssl",
          "account-virus-scan",
          "account-web-directives",
          "acct-backup-runs",
          "acct-convert-addon",
          "acct-enhancements",
          "acct-restore",
          "acct-staging",
          "acct-team",
          "acct-templates",
          "acct-transfer-credentials",
          "approved-host-services",
          "database-workspace",
          "db-engines",
          "directory-privacy",
          "domain-create-fields",
          "domain-workspace-buttons",
          "file-workspace-browse",
          "file-workspace-trash",
          "handoff-mailbox-select-id",
          "mail-attachments-mounted-reading-root",
          "mail-attachments-root",
          "mail-calendar-controls",
          "mail-calendar-day-focus",
          "mail-calendar-view-controls",
          "mail-compose-attachments-root",
          "mail-contacts-buttons",
          "mail-contacts-fields",
          "mail-contacts-tools-root",
          "mail-folder-facts",
          "mail-folder-template-projections",
          "mail-identities-root",
          "mail-mailbox-forwarders-root",
          "mail-mailing-lists-root",
          "mail-preferences-selects",
          "mail-search-detail-fields",
          "mail-track-facts",
          "mail-vacation-buttons",
          "mail-vacation-fields",
          "mailx-archive-facts",
          "mailx-collections-controls",
          "mailx-list-delivery-facts",
          "mailx-spam-delivery-facts",
          "ops-file-sharing-dynamic-48",
          "ops-file-sharing-dynamic-57",
          "ops-integrations-dynamic-48",
          "ops-integrations-dynamic-56",
          "ops-nodes-dynamic-36",
          "ops-nodes-dynamic-37",
          "ops-nodes-dynamic-47",
          "site-health",
          "sw-addon-services",
          "sw-app-projects",
          "sw-containers-dynamic-114",
          "sw-containers-list",
          "sw-deployments-dynamic-43",
          "sw-optimize-dynamic-18",
          "whm-account-health-dynamic-224",
          "whm-account-health-dynamic-266",
          "whm-account-health-dynamic-71",
          "whm-announcements-forwarded",
          "whm-backup-destinations-dynamic-43",
          "whm-backup-files-dynamic-80",
          "whm-backups-dynamic-104",
          "whm-backups-dynamic-105",
          "whm-backups-dynamic-106",
          "whm-backups-dynamic-371",
          "whm-backups-forwarded",
          "whm-composer-dynamic-29",
          "whm-database-tuning-dynamic-87",
          "whm-databases-dynamic-136",
          "whm-databases-dynamic-143",
          "whm-developer-forwarded",
          "whm-dns-dynamic-23",
          "whm-dns-tools-dynamic-166",
          "whm-dns-tools-forwarded",
          "whm-firewall-dynamic-117",
          "whm-firewall-dynamic-164",
          "whm-firewall-dynamic-172",
          "whm-firewall-dynamic-175",
          "whm-ips",
          "whm-jobs-dynamic-119",
          "whm-jobs-forwarded",
          "whm-local-archives",
          "whm-mail-log-dynamic-118",
          "whm-mail-log-dynamic-192",
          "whm-mail-quality-dynamic-109",
          "whm-mail-queue-dynamic-58",
          "whm-mail-queue-dynamic-92",
          "whm-mail-server-dynamic-107",
          "whm-mail-server-dynamic-121",
          "whm-mailbox-maintenance-forwarded",
          "whm-monitoring-alerts-dynamic-112",
          "whm-monitoring-alerts-dynamic-119",
          "whm-monitoring-alerts-dynamic-128",
          "whm-monitoring-dynamic-118",
          "whm-monitoring-dynamic-340",
          "whm-panel-data",
          "whm-panel-notifications-dynamic-71",
          "whm-panel-notifications-forwarded",
          "whm-panel-tokens-forwarded",
          "whm-repair-dynamic-84",
          "whm-server-health-dynamic-116",
          "whm-server-health-dynamic-299",
          "whm-service-manager-forwarded",
          "whm-software-center-forwarded",
          "whm-ssl-dynamic-75",
          "whm-ssl-install-dynamic-108",
          "whm-ssl-observations-forwarded",
          "whm-support-dynamic-134",
          "whm-support-dynamic-93",
          "whm-support-dynamic-96",
          "whm-support-forwarded",
          "whm-transfer-dynamic-213",
          "whm-transfer-dynamic-28",
          "whm-transfer-dynamic-29",
          "whm-transfer-import-projections",
          "whm-updates-dynamic-58",
          "whm-updates-dynamic-83",
          "zone-editor"
        ]
      },
      {
        "line": 15,
        "column": 101,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "validated-unique-clone-slot",
        "controllers": [
          "account-backup",
          "account-cron",
          "account-database-insights",
          "account-database-remote",
          "account-dynamic-dns",
          "account-filters",
          "account-forwarders",
          "account-forwarders:variants:1",
          "account-forwarders:variants:2",
          "account-git",
          "account-htaccess",
          "account-logs",
          "account-mailing-lists",
          "account-network-tools",
          "account-packages",
          "account-pgp",
          "account-quarantine",
          "account-reverse-proxy",
          "account-runtime",
          "account-sessions",
          "account-site-publisher",
          "account-ssh",
          "account-ssl",
          "account-virus-scan",
          "account-web-directives",
          "acct-backup-runs",
          "acct-convert-addon",
          "acct-enhancements",
          "acct-restore",
          "acct-staging",
          "acct-team",
          "acct-templates",
          "acct-transfer-credentials",
          "approved-host-services",
          "database-workspace",
          "db-engines",
          "directory-privacy",
          "domain-create-fields",
          "domain-workspace-buttons",
          "file-workspace-browse",
          "file-workspace-trash",
          "handoff-mailbox-select-id",
          "mail-attachments-mounted-reading-root",
          "mail-attachments-root",
          "mail-calendar-controls",
          "mail-calendar-day-focus",
          "mail-calendar-view-controls",
          "mail-compose-attachments-root",
          "mail-contacts-buttons",
          "mail-contacts-fields",
          "mail-contacts-tools-root",
          "mail-folder-facts",
          "mail-folder-template-projections",
          "mail-identities-root",
          "mail-mailbox-forwarders-root",
          "mail-mailing-lists-root",
          "mail-preferences-selects",
          "mail-search-detail-fields",
          "mail-track-facts",
          "mail-vacation-buttons",
          "mail-vacation-fields",
          "mailx-archive-facts",
          "mailx-collections-controls",
          "mailx-list-delivery-facts",
          "mailx-spam-delivery-facts",
          "ops-file-sharing-dynamic-48",
          "ops-file-sharing-dynamic-57",
          "ops-integrations-dynamic-48",
          "ops-integrations-dynamic-56",
          "ops-nodes-dynamic-36",
          "ops-nodes-dynamic-37",
          "ops-nodes-dynamic-47",
          "site-health",
          "sw-addon-services",
          "sw-app-projects",
          "sw-containers-dynamic-114",
          "sw-containers-list",
          "sw-deployments-dynamic-43",
          "sw-optimize-dynamic-18",
          "whm-account-health-dynamic-224",
          "whm-account-health-dynamic-266",
          "whm-account-health-dynamic-71",
          "whm-announcements-forwarded",
          "whm-backup-destinations-dynamic-43",
          "whm-backup-files-dynamic-80",
          "whm-backups-dynamic-104",
          "whm-backups-dynamic-105",
          "whm-backups-dynamic-106",
          "whm-backups-dynamic-371",
          "whm-backups-forwarded",
          "whm-composer-dynamic-29",
          "whm-database-tuning-dynamic-87",
          "whm-databases-dynamic-136",
          "whm-databases-dynamic-143",
          "whm-developer-forwarded",
          "whm-dns-dynamic-23",
          "whm-dns-tools-dynamic-166",
          "whm-dns-tools-forwarded",
          "whm-firewall-dynamic-117",
          "whm-firewall-dynamic-164",
          "whm-firewall-dynamic-172",
          "whm-firewall-dynamic-175",
          "whm-ips",
          "whm-jobs-dynamic-119",
          "whm-jobs-forwarded",
          "whm-local-archives",
          "whm-mail-log-dynamic-118",
          "whm-mail-log-dynamic-192",
          "whm-mail-quality-dynamic-109",
          "whm-mail-queue-dynamic-58",
          "whm-mail-queue-dynamic-92",
          "whm-mail-server-dynamic-107",
          "whm-mail-server-dynamic-121",
          "whm-mailbox-maintenance-forwarded",
          "whm-monitoring-alerts-dynamic-112",
          "whm-monitoring-alerts-dynamic-119",
          "whm-monitoring-alerts-dynamic-128",
          "whm-monitoring-dynamic-118",
          "whm-monitoring-dynamic-340",
          "whm-panel-data",
          "whm-panel-notifications-dynamic-71",
          "whm-panel-notifications-forwarded",
          "whm-panel-tokens-forwarded",
          "whm-repair-dynamic-84",
          "whm-server-health-dynamic-116",
          "whm-server-health-dynamic-299",
          "whm-service-manager-forwarded",
          "whm-software-center-forwarded",
          "whm-ssl-dynamic-75",
          "whm-ssl-install-dynamic-108",
          "whm-ssl-observations-forwarded",
          "whm-support-dynamic-134",
          "whm-support-dynamic-93",
          "whm-support-dynamic-96",
          "whm-support-forwarded",
          "whm-transfer-dynamic-213",
          "whm-transfer-dynamic-28",
          "whm-transfer-dynamic-29",
          "whm-transfer-import-projections",
          "whm-updates-dynamic-58",
          "whm-updates-dynamic-83",
          "zone-editor"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/workspace-view-templates.ts",
    "sha256": "b255eee649e6f2a7ff7924bdf09471ae5391851dc4454ed628194c3bc78a385e",
    "sites": [
      {
        "line": 29,
        "column": 37,
        "method": "matches",
        "argument": "selector",
        "classification": "validated-unique-clone-action",
        "controllers": [
          "account-filters",
          "acct-templates",
          "acct-transfer-credentials",
          "approved-host-services",
          "ops-file-sharing-dynamic-48",
          "ops-file-sharing-dynamic-57",
          "ops-integrations-dynamic-48",
          "ops-integrations-dynamic-56",
          "ops-nodes-dynamic-36",
          "ops-nodes-dynamic-37",
          "ops-nodes-dynamic-47",
          "sw-addon-services",
          "sw-containers-dynamic-114",
          "sw-containers-list",
          "sw-deployments-dynamic-43",
          "whm-backup-destinations-dynamic-43",
          "whm-backup-files-dynamic-80",
          "whm-firewall-dynamic-117",
          "whm-firewall-dynamic-164",
          "whm-firewall-dynamic-172",
          "whm-firewall-dynamic-175",
          "whm-ips",
          "whm-service-manager-forwarded",
          "whm-transfer-dynamic-213",
          "whm-transfer-dynamic-28",
          "whm-transfer-dynamic-29",
          "whm-transfer-import-projections",
          "whm-updates-dynamic-58",
          "whm-updates-dynamic-83"
        ]
      },
      {
        "line": 29,
        "column": 101,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "validated-unique-clone-action",
        "controllers": [
          "account-filters",
          "acct-templates",
          "acct-transfer-credentials",
          "approved-host-services",
          "ops-file-sharing-dynamic-48",
          "ops-file-sharing-dynamic-57",
          "ops-integrations-dynamic-48",
          "ops-integrations-dynamic-56",
          "ops-nodes-dynamic-36",
          "ops-nodes-dynamic-37",
          "ops-nodes-dynamic-47",
          "sw-addon-services",
          "sw-containers-dynamic-114",
          "sw-containers-list",
          "sw-deployments-dynamic-43",
          "whm-backup-destinations-dynamic-43",
          "whm-backup-files-dynamic-80",
          "whm-firewall-dynamic-117",
          "whm-firewall-dynamic-164",
          "whm-firewall-dynamic-172",
          "whm-firewall-dynamic-175",
          "whm-ips",
          "whm-service-manager-forwarded",
          "whm-transfer-dynamic-213",
          "whm-transfer-dynamic-28",
          "whm-transfer-dynamic-29",
          "whm-transfer-import-projections",
          "whm-updates-dynamic-58",
          "whm-updates-dynamic-83"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-details-client.ts",
    "sha256": "9d429fa50a496387be00e9d86d94913e9e8d38fc35be030d56e94b390f2f9f1a",
    "sites": [
      {
        "line": 8,
        "column": 59,
        "method": "querySelectorAll",
        "argument": "rootSelector",
        "classification": "literal-workspace-root-reference",
        "controllers": [
          "whm-account-details"
        ]
      },
      {
        "line": 12,
        "column": 91,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-owned-control-selector",
        "controllers": [
          "whm-account-details"
        ]
      },
      {
        "line": 12,
        "column": 130,
        "method": "closest",
        "argument": "rootSelector",
        "classification": "literal-owning-workspace-root-reference",
        "controllers": [
          "whm-account-details"
        ]
      },
      {
        "line": 47,
        "column": 34,
        "method": "querySelectorAll",
        "argument": "rootSelector",
        "classification": "literal-workspace-root-reference",
        "controllers": [
          "whm-account-details"
        ]
      },
      {
        "line": 50,
        "column": 29,
        "method": "closest",
        "argument": "rootSelector",
        "classification": "literal-owning-workspace-root-reference",
        "controllers": [
          "whm-account-details"
        ]
      },
      {
        "line": 50,
        "column": 73,
        "method": "closest",
        "argument": "rootSelector",
        "classification": "literal-owning-workspace-root-reference",
        "controllers": [
          "whm-account-details"
        ]
      },
      {
        "line": 50,
        "column": 119,
        "method": "closest",
        "argument": "rootSelector",
        "classification": "literal-owning-workspace-root-reference",
        "controllers": [
          "whm-account-details"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/plan-editor.ts",
    "sha256": "b33f08a252285284310f3b7c9e200277157ed7e0792fde2ffc5287e35483d0f1",
    "sites": [
      {
        "line": 160,
        "column": 148,
        "method": "querySelectorAll",
        "argument": "'[data-plan-review-' + slot + ']'",
        "classification": "finite-plan-review-cell-selector",
        "controllers": [
          "native-plan-review"
        ]
      },
      {
        "line": 191,
        "column": 57,
        "method": "querySelector",
        "argument": "'[data-plan-review-' + slot + ']'",
        "classification": "finite-plan-review-cell-selector",
        "controllers": [
          "native-plan-review"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/presentation-tabs-client.ts",
    "sha256": "f961db74e77f3543c1f57968290656fe65f19cafc98fae6c2c407530b1256a33",
    "sites": [
      {
        "line": 15,
        "column": 57,
        "method": "querySelectorAll",
        "argument": "rootSelector",
        "classification": "literal-workspace-root-reference",
        "controllers": [
          "presentation-tabs"
        ]
      },
      {
        "line": 17,
        "column": 93,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-owned-control-selector",
        "controllers": [
          "presentation-tabs"
        ]
      },
      {
        "line": 17,
        "column": 132,
        "method": "closest",
        "argument": "rootSelector",
        "classification": "literal-owning-workspace-root-reference",
        "controllers": [
          "presentation-tabs"
        ]
      },
      {
        "line": 51,
        "column": 118,
        "method": "closest",
        "argument": "rootSelector",
        "classification": "literal-owning-workspace-root-reference",
        "controllers": [
          "presentation-tabs"
        ]
      },
      {
        "line": 61,
        "column": 127,
        "method": "closest",
        "argument": "rootSelector",
        "classification": "literal-owning-workspace-root-reference",
        "controllers": [
          "presentation-tabs"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/prompt-client.ts",
    "sha256": "1e5d4f39366f0080ca2a87a031ca5c3c2b0c82f05cdc04b3a43c46efcf83ad76",
    "sites": [
      {
        "line": 57,
        "column": 84,
        "method": "getElementById",
        "argument": "id",
        "classification": "cloned-prompt-descendant-identity-guard",
        "controllers": [
          "shared-prompt-dialog"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-security-client.ts",
    "sha256": "249a040eb4c9c1fdc32f92224975ec1a82b9fea43e332b8a45dd494a3ebebd9f",
    "sites": [
      {
        "line": 25,
        "column": 64,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-owned-typed-control-selector",
        "controllers": [
          "whm-security-evidence"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-ssh-client.ts",
    "sha256": "38a2dadb598a517875c0c6173450d2a957522ea4f8ea1da65387cc4df42964be",
    "sites": [
      {
        "line": 44,
        "column": 187,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 44,
        "column": 213,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 65,
        "column": 64,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-owned-typed-control-selector",
        "controllers": [
          "whm-ssh-workspace"
        ]
      },
      {
        "line": 99,
        "column": 199,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-password-client.ts",
    "sha256": "58700d0e9ba4d98a92a593da9832ac2d857283cc565b94c3dddc9ac5e22d9c15",
    "sites": [
      {
        "line": 13,
        "column": 105,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-password"
        ]
      },
      {
        "line": 52,
        "column": 24,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-api-tokens-client.ts",
    "sha256": "3955102d59bfd84f56e3867d8632609e09195c11304a614cfc808de287874c7f",
    "sites": [
      {
        "line": 55,
        "column": 95,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-api-tokens"
        ]
      },
      {
        "line": 95,
        "column": 153,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 105,
        "column": 128,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  }
]
