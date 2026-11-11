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
  },
  {
    "path": "apps/web/src/account-backup-client.ts",
    "sha256": "0aa9d0bf8cc4bcf6894943f007a102be298fc7353229f22a9bc62332454475e5",
    "sites": [
      {
        "line": 70,
        "column": 94,
        "method": "querySelector",
        "argument": "'[data-account-backup-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-backup"
        ]
      },
      {
        "line": 74,
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
    "sha256": "b8e597aea34230d4a57ad465e6dbd2a49a4a48a6b10986a807ffcd0cecdb97af",
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
    "sha256": "0d115293dc4eda6626a2a8282396be6134f6b831a6c1dac5821c562108aba70c",
    "sites": [
      {
        "line": 62,
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
    "path": "apps/web/src/account-details-client.ts",
    "sha256": "b581a49063f951404f2a338945390a17517f0939d80e3d8a12d1bddafabdad53",
    "sites": [
      {
        "line": 9,
        "column": 59,
        "method": "querySelectorAll",
        "argument": "rootSelector",
        "classification": "literal-workspace-root-reference",
        "controllers": [
          "whm-account-details"
        ]
      },
      {
        "line": 13,
        "column": 91,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-owned-control-selector",
        "controllers": [
          "whm-account-details"
        ]
      },
      {
        "line": 13,
        "column": 130,
        "method": "closest",
        "argument": "rootSelector",
        "classification": "literal-owning-workspace-root-reference",
        "controllers": [
          "whm-account-details"
        ]
      },
      {
        "line": 49,
        "column": 34,
        "method": "querySelectorAll",
        "argument": "rootSelector",
        "classification": "literal-workspace-root-reference",
        "controllers": [
          "whm-account-details"
        ]
      },
      {
        "line": 52,
        "column": 29,
        "method": "closest",
        "argument": "rootSelector",
        "classification": "literal-owning-workspace-root-reference",
        "controllers": [
          "whm-account-details"
        ]
      },
      {
        "line": 52,
        "column": 73,
        "method": "closest",
        "argument": "rootSelector",
        "classification": "literal-owning-workspace-root-reference",
        "controllers": [
          "whm-account-details"
        ]
      },
      {
        "line": 52,
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
    "path": "apps/web/src/account-edge-client.ts",
    "sha256": "0f487b06ec332093b503d3c2391c27eed665ee37b1a059241c155bfab810be5d",
    "sites": [
      {
        "line": 63,
        "column": 108,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 115,
        "column": 107,
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
    "path": "apps/web/src/account-filters-client.ts",
    "sha256": "6939e5bda12050fd992685e3d723fab41aa593b4c1f885e7d1c952acdcceacd9",
    "sites": [
      {
        "line": 72,
        "column": 72,
        "method": "closest",
        "argument": "blockedAncestor",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 114,
        "column": 38,
        "method": "closest",
        "argument": "blockedAncestor",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 236,
        "column": 77,
        "method": "querySelector",
        "argument": "'[data-'+key+'-field=\"'+name+'\"]'",
        "classification": "finite-nested-client-row",
        "controllers": [
          "account-filters"
        ]
      },
      {
        "line": 287,
        "column": 60,
        "method": "closest",
        "argument": "blockedAncestor",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 288,
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
    "sha256": "54d77a8a294fd7db0491f717236f1a2163a2a635a07502b8418420fc0f5d61e9",
    "sites": [
      {
        "line": 76,
        "column": 52,
        "method": "querySelector",
        "argument": "`[data-${key}-status]`",
        "classification": "finite-nullable-section-key",
        "controllers": [
          "account-forwarders"
        ]
      },
      {
        "line": 81,
        "column": 72,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 85,
        "column": 117,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 291,
        "column": 59,
        "method": "querySelector",
        "argument": "`input[name=\"default-kind\"][value=\"${String(record?.kind ?? 'reject')}\"]`",
        "classification": "nullable-provider-row-lookup",
        "controllers": [
          "account-forwarders"
        ]
      },
      {
        "line": 299,
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
    "sha256": "0ea51bc64e899298569e5899a6620e6bd26511583ed14f9e7efcd980b38127e4",
    "sites": [
      {
        "line": 51,
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
    "sha256": "7772c606ce5817d2dc0f6032c1f99ceb88fa090fbac4e722f4ebd3d4bc3df01c",
    "sites": [
      {
        "line": 125,
        "column": 113,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 126,
        "column": 94,
        "method": "querySelector",
        "argument": "'[data-htaccess-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-htaccess"
        ]
      },
      {
        "line": 161,
        "column": 57,
        "method": "querySelector",
        "argument": "'[data-htaccess-php-' + name + ']'",
        "classification": "finite-nullable-preview",
        "controllers": [
          "account-htaccess"
        ]
      },
      {
        "line": 161,
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
    "path": "apps/web/src/account-leech-client.ts",
    "sha256": "8c9ddc04a1c72e51f642c7ddb09feff3c1eea796dde01dd32140b474b1da574d",
    "sites": [
      {
        "line": 65,
        "column": 107,
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
    "path": "apps/web/src/account-list.ts",
    "sha256": "eb73309670cf808e5f713b6881f6a99afb1f8ab00d2a516def4a12fb84dd01f4",
    "sites": [
      {
        "line": 48,
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
    "sha256": "4d5ec95bbc6df4b71879e2f2d61b61b7162d61a64b85fc63b24cff69c038d9b5",
    "sites": [
      {
        "line": 146,
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
    "sha256": "f9e1ec00d491420635eedfa773bea8ec9742eb315626a2108454671c2e8e9bf2",
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
    "path": "apps/web/src/account-password-client.ts",
    "sha256": "29e9b8f52cd6fd44a9cce273a9971770f801af0975bd77cf475faa3b85f9816b",
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
        "line": 54,
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
    "sha256": "9d8cfd3719b696e299c515fea53d0f295596a1fa21b985381692c83be717e602",
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
    "sha256": "246e56c356b0d20b2821c5e1541d25bf43c13632e2f3bcc5c9b07a4b210d2664",
    "sites": [
      {
        "line": 20,
        "column": 68,
        "method": "querySelectorAll",
        "argument": "`template[data-xp-template=\"${name}\"]`",
        "classification": "finite-owned-client-template",
        "controllers": [
          "account-runtime"
        ]
      },
      {
        "line": 42,
        "column": 92,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-runtime"
        ]
      },
      {
        "line": 50,
        "column": 109,
        "method": "querySelector",
        "argument": "'[data-runtime-input=\"' + key + '\"]'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-runtime"
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
    "sha256": "7f2392c577061b0222ee4a463d3965923e9d90e97549383c37975cb6694a74df",
    "sites": [
      {
        "line": 66,
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
    "path": "apps/web/src/account-site-settings-client.ts",
    "sha256": "1551c6b9bc2ad7c0abd551369db469d9729f15261b2ad52e02b9f48af3b2929e",
    "sites": [
      {
        "line": 62,
        "column": 83,
        "method": "querySelector",
        "argument": "'[data-site-' + key + ']'",
        "classification": "finite-required-controls",
        "controllers": [
          "account-site-settings"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-spam-client.ts",
    "sha256": "4b33b7be93038cfd31e5cbae298abe1d5e0e3db205a189de55eb0ea11b268e82",
    "sites": [
      {
        "line": 118,
        "column": 84,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-spam"
        ]
      },
      {
        "line": 119,
        "column": 77,
        "method": "querySelector",
        "argument": "'[data-spam-score=\"' + id + '\"]'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-spam"
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
    "sha256": "4761601c704c0059bc21036ed8a63b5cdaa8a9ef15857a5640e36702ca8005c6",
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
    "sha256": "b9070e96e613a1c91efcff497ffa26220931a6dce06c0b9b7cecc083383df4a8",
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
    "sha256": "4dcacdcd018bf30b7a57076421eaf4ff66d9fdd927b3cee91db545a9fe75e18e",
    "sites": [
      {
        "line": 161,
        "column": 88,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-web-directives"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/acct-backup-runs-client.ts",
    "sha256": "63ff05db2ff357d08c81895ef1645570d5c0bc7dfe9730dce59c7ca9b61390e2",
    "sites": [
      {
        "line": 109,
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
    "sha256": "94df4aa826723a913b28f80ae1611ffd29dcb896546716ad2b9ac4eb557db249",
    "sites": [
      {
        "line": 67,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-enhancements"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/acct-restore-client.ts",
    "sha256": "f3cc187ac4b5a04dc494b2235ce845d64a4b0e367fbe02af631b61de6b7200a2",
    "sites": [
      {
        "line": 89,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-restore-more-' + name + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-restore"
        ]
      },
      {
        "line": 116,
        "column": 87,
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
    "sha256": "4024e4f14e38c4d51bb223dc3da2028fb6c1881d4a7d9a0b5c0c3e75f967392e",
    "sites": [
      {
        "line": 56,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-staging-' + name + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-staging"
        ]
      },
      {
        "line": 71,
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
    "sha256": "3f4bfc5e9194870f71c9db26b47b0c5365b0a556a46a89b32bc6c9599b7d03ad",
    "sites": [
      {
        "line": 68,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-team"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/acct-templates-client.ts",
    "sha256": "e5b31602911c99a1f14421d97b4cdf09df237572bd88f3e62f6b6bf3513af9e2",
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
    "sha256": "92aadd860d2b367f0f6690a55694f6a9d26796b8fb4cdec0465bda1766ac3117",
    "sites": [
      {
        "line": 18,
        "column": 50,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "approved-host-services"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/board-port/account-announcements-banner-client.ts",
    "sha256": "bcbe8d4246b05ba033e2b4777c11c31379dacee1a3fc2de05e6a5cee9911dcd4",
    "sites": [
      {
        "line": 105,
        "column": 51,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 109,
        "column": 93,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-source-classified",
        "controllers": [
          "account-announcements-owned-root"
        ]
      },
      {
        "line": 125,
        "column": 45,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 138,
        "column": 134,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 154,
        "column": 154,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 165,
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
    "path": "apps/web/src/mail-compose-editor-client.ts",
    "sha256": "cf25fef80af8cfcd1014cb95ea2a246e1021008006b1d3c589602b034405bce9",
    "sites": [
      {
        "line": 24,
        "column": 34,
        "method": "querySelector",
        "argument": "'[data-mail-recip=\"' + field + '\"]'",
        "classification": "finite-recipient-kind-controls",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 32,
        "column": 35,
        "method": "querySelector",
        "argument": "'[data-mail-recip=\"' + field + '\"] ul'",
        "classification": "finite-recipient-kind-controls",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 33,
        "column": 36,
        "method": "querySelector",
        "argument": "'[data-mail-recip-input=\"' + field + '\"]'",
        "classification": "finite-recipient-kind-controls",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 249,
        "column": 43,
        "method": "querySelectorAll",
        "argument": "'[data-mail-chip=\"' + field + '\"]'",
        "classification": "runtime-recipient-chip-collection",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 272,
        "column": 41,
        "method": "querySelectorAll",
        "argument": "'[data-mail-chip=\"' + field + '\"]'",
        "classification": "runtime-recipient-chip-collection",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 273,
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
    "sha256": "1e2aaa0abc319b86b476fff47981612e81f3d96dbef64e3ca8e9fef22d3a6ff3",
    "sites": [
      {
        "line": 430,
        "column": 44,
        "method": "querySelector",
        "argument": "'[data-reading-id=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 434,
        "column": 45,
        "method": "querySelector",
        "argument": "'[data-mail-open=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 446,
        "column": 44,
        "method": "querySelector",
        "argument": "selector",
        "classification": "keyed-optional-runtime-reading-projection",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 662,
        "column": 53,
        "method": "querySelector",
        "argument": "'[data-mail-open=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 665,
        "column": 61,
        "method": "querySelector",
        "argument": "'[data-reading-id=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 799,
        "column": 53,
        "method": "querySelector",
        "argument": "'[data-mail-open=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 802,
        "column": 57,
        "method": "querySelector",
        "argument": "'[data-reading-id=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 803,
        "column": 56,
        "method": "querySelector",
        "argument": "'[data-reading-id=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 820,
        "column": 50,
        "method": "querySelector",
        "argument": "'[data-mail-count=\"' + counts[c].getAttribute('data-mail-count') + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 827,
        "column": 32,
        "method": "querySelector",
        "argument": "'[data-mail-count=\"' + observedCounts[n].getAttribute('data-mail-count') + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 834,
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
    "sha256": "d69dcb07b6785a9a524b38b7f5c5d53d8a9375be29225bb8263adb8abf287965",
    "sites": [
      {
        "line": 1085,
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
        "line": 1086,
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
        "line": 1087,
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
        "line": 1088,
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
        "line": 1201,
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
        "line": 1319,
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
    "path": "apps/web/src/client-templates.ts",
    "sha256": "1384ace7b9ea8fc2fbaa3528affb7ed08446298e6f0010ba60dd81ec2c030d95",
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
    "path": "apps/web/src/command-palette-client.ts",
    "sha256": "25266dcb17fe98ecaa1f7ae5f42a769265656f85413f407af0ac62acf558b21a",
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
    "sha256": "126ed166a2bc0fc776719b375a714ee1defb776b806dfe6f1e85b4b6f1ad987a",
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
        "line": 216,
        "column": 114,
        "method": "querySelector",
        "argument": "'[name='+key+']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "database-workspace"
        ]
      },
      {
        "line": 218,
        "column": 143,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "database-workspace"
        ]
      },
      {
        "line": 228,
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
    "sha256": "77c32fc40bef853efb012ddc801404bbad7091ec09cab3d5d5da78a4cea3fd6d",
    "sites": [
      {
        "line": 125,
        "column": 115,
        "method": "querySelector",
        "argument": "'[data-db-fact=\"' + key + '\"]'",
        "classification": "finite-nullable-page-presentation",
        "controllers": [
          "db-engines"
        ]
      },
      {
        "line": 223,
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
    "sha256": "302ed427342f45f6007c2ca9a55965c13193f2be2155d1e5135f671627269539",
    "sites": [
      {
        "line": 144,
        "column": 96,
        "method": "querySelector",
        "argument": "'[name=\"'+name+'\"]'",
        "classification": "source-classified",
        "controllers": [
          "domain-create-fields"
        ]
      },
      {
        "line": 146,
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
    "sha256": "4981c59f10bc1265f69caf7a10a8f2b671cae3b826f07af1cc47702382103c4a",
    "sites": [
      {
        "line": 176,
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
        "line": 208,
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
        "line": 224,
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
        "line": 225,
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
        "line": 297,
        "column": 93,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 310,
        "column": 239,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 356,
        "column": 241,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 440,
        "column": 183,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 464,
        "column": 92,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 476,
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
    "path": "apps/web/src/home-tools-client.ts",
    "sha256": "e74416a05e09aaa336187f2e398f3e41af6fc0701c8f2d305945478170be8857",
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
    "path": "apps/web/src/login-client.ts",
    "sha256": "a3d180db3d50054ae87a8efa23887c35ef3afe4a94302ced2c05f01a8301eda4",
    "sites": [
      {
        "line": 40,
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
        "line": 42,
        "column": 72,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "login-view-switches"
        ]
      },
      {
        "line": 320,
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
    "sha256": "28555c98362f574e39d5971f9516b94598b1cb8727fc15849ebd1a0f35bcad1b",
    "sites": []
  },
  {
    "path": "apps/web/src/mail-calendar-client.ts",
    "sha256": "00c7e2ac9b5eb22fa0bee79db469ee345b46f664f5aa4bd4d1feeb65836d8b4f",
    "sites": [
      {
        "line": 28,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-calendar-' + key + ']'",
        "classification": "source-classified",
        "controllers": [
          "mail-calendar-controls"
        ]
      },
      {
        "line": 29,
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
    "sha256": "c9e12b9be9d11e9fc19c172f45a0683b887178a28d0acb52b982499b227750ae",
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
    "sha256": "238d29fe962998664f38325dae0bf2649c8431cedb1ea4c042afad7245fa88a7",
    "sites": []
  },
  {
    "path": "apps/web/src/mail-connect-devices-client.ts",
    "sha256": "e904b6f29a9911c17ae4cdeb8d97f1d28afb83080d88c10bb0e3a677fdd7459d",
    "sites": []
  },
  {
    "path": "apps/web/src/mail-contact-groups-client.ts",
    "sha256": "f4b6c149242cdfb9db886bfded93f891d1f9f2650a31400a4a195ee43ffdcb1f",
    "sites": [
      {
        "line": 36,
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
    "sha256": "283bb53e8983e441029a59c97a89486d3f80af0e46911ee2ecd1d3b23bd712a4",
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
    "sha256": "beee3b625040c9c9232127c69d80e454fc0f3f135c83dca8a99cd4c8c8d23381",
    "sites": [
      {
        "line": 94,
        "column": 135,
        "method": "querySelector",
        "argument": "'[data-contact-'+key+']'",
        "classification": "source-classified",
        "controllers": [
          "mail-contacts-buttons"
        ]
      },
      {
        "line": 103,
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
    "sha256": "937b5d6900ed5fe1abac97e42eb7bc90924f98bb350dbfcb7dfb608033326e69",
    "sites": [
      {
        "line": 102,
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
    "sha256": "711758afed3f90e4a53e861279d255354ec38bac0f16b259ea49c3f8fefcd2e3",
    "sites": [
      {
        "line": 195,
        "column": 877,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "mail-folder-template-projections"
        ]
      },
      {
        "line": 203,
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
    "sha256": "bd6fb9564a2ab77f1f9be0233bfc13a2f60a90bb39fb2f33b843fe3c443dbf02",
    "sites": [
      {
        "line": 69,
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
    "sha256": "a8ca60e268f46535f49646c9af862ab62e018abb00d22682e15afce09118b7a3",
    "sites": []
  },
  {
    "path": "apps/web/src/mail-mailbox-forwarders-client.ts",
    "sha256": "3252069cac6873c5b09e4484eb79eb7a7f82ea66d3062d6fc10cb177a1353dee",
    "sites": []
  },
  {
    "path": "apps/web/src/mail-mailbox-preferences-client.ts",
    "sha256": "833fb35ee52608c482984127322a94c36e69c61ad40ea720a4c0a022d205c13a",
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
    "sha256": "400b811eb4493528a1a77d6c16cc1284da4b3dac0cd7e653bb3acb235b4d3af0",
    "sites": [
      {
        "line": 42,
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
    "sha256": "2dddd864acc228214d90b48910c0e202a77085caac84f859a632eefed2120086",
    "sites": [
      {
        "line": 71,
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
    "sha256": "d289bcfe52c91e1600318df5d8e99e2c009f9f009753bd56ad672e5ee4ad49df",
    "sites": [
      {
        "line": 85,
        "column": 178,
        "method": "querySelector",
        "argument": "'[data-vacation-'+key+']'",
        "classification": "source-classified",
        "controllers": [
          "mail-vacation-buttons"
        ]
      },
      {
        "line": 93,
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
    "sha256": "652a340f90490b9ce85e562728b2424ceb2182fd2b075e8130d46a98ba04394e",
    "sites": [
      {
        "line": 53,
        "column": 82,
        "method": "querySelector",
        "argument": "'[data-mailx-' + key + ']'",
        "classification": "source-classified",
        "controllers": [
          "mailx-collections-controls"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/mailx-mail-tools-client.ts",
    "sha256": "24e6c544585c31638e711a5fab7a6b87004049d3c3974cfc8617782593dbc1b0",
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
    "sha256": "3b4a6d146f20d413a9cdd7c6c399041a50b92cefaae53120979be31284d9b13c",
    "sites": [
      {
        "line": 72,
        "column": 105,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 73,
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
        "line": 81,
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
    "path": "apps/web/src/mobile-navigation-client.ts",
    "sha256": "d1bf031492d1b33e57c0b7b26f94db0b92b2188a055cd83eb3858d8e788ebd03",
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
    "path": "apps/web/src/ops-file-sharing-client.ts",
    "sha256": "524303415364d89679d5c9ff9e34ffe3838468aea4ba7bea100b1d2920cc975e",
    "sites": [
      {
        "line": 53,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-ops-shares-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-file-sharing-dynamic-48"
        ]
      },
      {
        "line": 59,
        "column": 110,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 72,
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
    "sha256": "f0c69e1a4f0af6cbd1d9938a6b6264f7907a073fcaaa714f78c1f33a582d7c75",
    "sites": [
      {
        "line": 53,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-ops-int-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-integrations-dynamic-48"
        ]
      },
      {
        "line": 58,
        "column": 107,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 75,
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
    "sha256": "6afa2a3e522e756deee7c0123771648a69e37a3d0c23849990d47b89fc7455db",
    "sites": [
      {
        "line": 52,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-ops-nodes-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-nodes-dynamic-36"
        ]
      },
      {
        "line": 53,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-ops-nodes-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-nodes-dynamic-37"
        ]
      },
      {
        "line": 59,
        "column": 109,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 72,
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
    "sha256": "986051014feb1c56c329b429963729613604bc467233a502f9a1c89a43b8041d",
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
    "path": "apps/web/src/panel-tools-client.ts",
    "sha256": "6d251a94a89d1bdc223c67af7642af0e2fa3dbd2fbaa82cee2cd301b3cd501d5",
    "sites": [
      {
        "line": 16,
        "column": 114,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "panel-api-shell",
          "account-packages",
          "panel-backups",
          "panel-config-code",
          "panel-error-reporting",
          "panel-metrics-export",
          "panel-plugin-import",
          "panel-projects",
          "panel-python-runtimes"
        ]
      },
      {
        "line": 30,
        "column": 85,
        "method": "closest",
        "argument": "blocked",
        "classification": "ancestor-eligibility-policy",
        "controllers": [
          "panel-api-shell",
          "account-packages",
          "panel-backups",
          "panel-config-code",
          "panel-error-reporting",
          "panel-metrics-export",
          "panel-plugin-import",
          "panel-projects",
          "panel-python-runtimes"
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
    "path": "apps/web/src/plan-editor.ts",
    "sha256": "8e7c378c3bce8a9e97f3d5fee3640ad2fb0a373cae87ab7ead420d035bdf469f",
    "sites": [
      {
        "line": 143,
        "column": 148,
        "method": "querySelectorAll",
        "argument": "'[data-plan-review-' + slot + ']'",
        "classification": "finite-plan-review-cell-selector",
        "controllers": [
          "native-plan-review"
        ]
      },
      {
        "line": 174,
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
    "sha256": "4bcc3eadb01c90a92dcedac44cc2851aa63259aceac774af21916c2b644d0f2c",
    "sites": [
      {
        "line": 59,
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
    "path": "apps/web/src/sec-security-client.ts",
    "sha256": "0ff21c15b365099d734c166cff04cd30f27b9010ce69cc5b038363314366b4f4",
    "sites": [
      {
        "line": 49,
        "column": 100,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "sec-kit-account-cloudflare",
          "sec-kit-account-waf",
          "dns-cluster-members",
          "sec-kit-compiler-access",
          "sec-kit-dns-cluster",
          "sec-kit-dns-providers",
          "sec-kit-flood",
          "sec-kit-panel-access",
          "sec-kit-waf",
          "whm-db-profiles"
        ]
      },
      {
        "line": 50,
        "column": 104,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "sec-kit-account-cloudflare",
          "sec-kit-account-waf",
          "dns-cluster-members",
          "sec-kit-compiler-access",
          "sec-kit-dns-cluster",
          "sec-kit-dns-providers",
          "sec-kit-flood",
          "sec-kit-panel-access",
          "sec-kit-waf",
          "whm-db-profiles"
        ]
      },
      {
        "line": 57,
        "column": 65,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 133,
        "column": 156,
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
    "sha256": "cd8fe2562943f24b76130733b19a633a181c5d85ef69829fc5b3965f74624c3d",
    "sites": [
      {
        "line": 38,
        "column": 67,
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
    "sha256": "18f7a4e35491191fdc0d491729ada9e5234a702851e0134f381929a47eb83c53",
    "sites": []
  },
  {
    "path": "apps/web/src/sw-applications-client.ts",
    "sha256": "325b897e48aef09c48bee910c39e92571606f6f6618577ec5640b31ee8efd010",
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
      }
    ]
  },
  {
    "path": "apps/web/src/sw-containers-client.ts",
    "sha256": "200204471bfe053fc2cf97e49f52497538e4b1ff15e01f67fe7542985ba6c5ee",
    "sites": [
      {
        "line": 50,
        "column": 67,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 116,
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
    "sha256": "bd952c39597867aa9e546d0f5e26f0e022980460593ca37d9cce25dfafe92dad",
    "sites": [
      {
        "line": 47,
        "column": 87,
        "method": "querySelector",
        "argument": "'[data-sw-dep-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "sw-deployments-dynamic-43"
        ]
      },
      {
        "line": 55,
        "column": 100,
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
    "sha256": "a9faf3eb22f0ffa7b10f55c3b700f0179f9556f9ee9c53fdb3792eb4b8ed58fd",
    "sites": [
      {
        "line": 23,
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
    "path": "apps/web/src/whm-account-admin-client.ts",
    "sha256": "0e69e838d04bc92ad55722db401435c8c870b58d3788286b8f7839e0c30bb02a",
    "sites": [
      {
        "line": 65,
        "column": 86,
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
    "path": "apps/web/src/whm-account-health-client.ts",
    "sha256": "149eb7a6446c9f5ec374c8cb38ce5695c384607f705e165d4748cfd4a00954b7",
    "sites": [
      {
        "line": 76,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-health-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-account-health-dynamic-71"
        ]
      },
      {
        "line": 233,
        "column": 115,
        "method": "querySelector",
        "argument": "'[data-whm-health-account=\"' + account.username + '\"]'",
        "classification": "runtime-generated-optional",
        "controllers": [
          "whm-account-health-dynamic-224"
        ]
      },
      {
        "line": 275,
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
    "sha256": "f71dbe26a35bf6895d0216c3baa884781b8a9269b90979b0c94c6198b0e1abd2",
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
    "sha256": "a4fe17b9c803d4d2222fafe45e10e8dcbc80a31fec57230cf69a7e127db7ab79",
    "sites": [
      {
        "line": 92,
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
    "sha256": "b44c7b95bafe06e46954b03438d8f0149edd3a181c35c9ea660aace243c1e939",
    "sites": [
      {
        "line": 88,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-backup-files-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backup-files-dynamic-80"
        ]
      },
      {
        "line": 103,
        "column": 30,
        "method": "matches",
        "argument": "selector",
        "classification": "finite-exact-template-slot",
        "controllers": [
          "whm-backup-files-dynamic-80"
        ]
      },
      {
        "line": 103,
        "column": 79,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-exact-template-slot",
        "controllers": [
          "whm-backup-files-dynamic-80"
        ]
      },
      {
        "line": 125,
        "column": 87,
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
    "path": "apps/web/src/whm-backups-client.ts",
    "sha256": "022e8ed98772d4209d2b27995d479c91b306b9f7f6be05796655f89504560e07",
    "sites": [
      {
        "line": 154,
        "column": 91,
        "method": "querySelector",
        "argument": "'#backup-layout-' + key",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backups-dynamic-104"
        ]
      },
      {
        "line": 155,
        "column": 94,
        "method": "querySelector",
        "argument": "'#backup-layout-' + key",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backups-dynamic-105"
        ]
      },
      {
        "line": 156,
        "column": 94,
        "method": "querySelector",
        "argument": "'[data-backup-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backups-dynamic-106"
        ]
      },
      {
        "line": 438,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-backups-forwarded"
        ]
      },
      {
        "line": 439,
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
    "sha256": "3554934cb9bfa0e7b5f57098d82c62ffca47f877b0dcd4c1af246503b79727b6",
    "sites": [
      {
        "line": 36,
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
    "sha256": "c98f0d5ef1c432b4320ed069d56333c7c31c016e7fd66b5b8c4546e6e50d602b",
    "sites": [
      {
        "line": 17,
        "column": 78,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-configuration-health-forwarded"
        ]
      },
      {
        "line": 25,
        "column": 134,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 47,
        "column": 57,
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
    "sha256": "2028e04c1dd038516f41b88a9e2debca286cf21e22349f5d7ac8e49fb39a70d5",
    "sites": [
      {
        "line": 95,
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
    "sha256": "c15e4410438223748e2086a01f5329d6d96caf28287e4b42ac677d078345af85",
    "sites": [
      {
        "line": 147,
        "column": 65,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 149,
        "column": 67,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 164,
        "column": 54,
        "method": "querySelector",
        "argument": "'[data-whm-db-fact=\"' + key + '\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-databases-dynamic-136"
        ]
      },
      {
        "line": 171,
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
    "sha256": "dca8706a2f883aefa808f939d6ab3d8f5c80df20ce5e0342c16871f69d2b2de7",
    "sites": [
      {
        "line": 58,
        "column": 95,
        "method": "querySelector",
        "argument": "s",
        "classification": "source-classified",
        "controllers": [
          "whm-developer-forwarded"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-dns-client.ts",
    "sha256": "9af5071631f1c3206d5b25f298f2483e9845e6ab70d02335571ea03cacdbf8b0",
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
    "sha256": "979426656214f693c0d08aaf08d62c1f318658949348d013b18799a2d99eae9f",
    "sites": [
      {
        "line": 119,
        "column": 102,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-dns-tools-forwarded"
        ]
      },
      {
        "line": 126,
        "column": 112,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 168,
        "column": 106,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-dns-tools-forwarded"
        ]
      },
      {
        "line": 174,
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
    "sha256": "5a2bc071c79ff413f4c4af997448855960afb6557e9a1584490c86c265eab24f",
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
    "sha256": "68a11aed55a60d4c83c697d865a7b120d1716fb746db50b20ae2d7c760f8e380",
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
    "sha256": "7f6e2ea7e93dd6590516b3fdb0ec20b7d97140c32b8f1c25c6713817941878d9",
    "sites": [
      {
        "line": 123,
        "column": 103,
        "method": "querySelector",
        "argument": "'[data-ftp-log-fact=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-ftp-log-dynamic-115"
        ]
      },
      {
        "line": 142,
        "column": 64,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "whm-ftp-log-workspace-controls"
        ]
      },
      {
        "line": 162,
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
    "sha256": "4b9a69e55246a2128ca107f4fd0fb9e2756702c0a1298a9a7ca71eb5293849ff",
    "sites": [
      {
        "line": 74,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-jobs-forwarded"
        ]
      },
      {
        "line": 116,
        "column": 108,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 148,
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
    "sha256": "f88008663d0e43b37c7f73cd732d04609248cb78e1848b98a7589c3760675884",
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
    "sha256": "f4236db774c6a3155120fb57233c547ce516ce9a2f3cb14a3827ce48b54e0dff",
    "sites": [
      {
        "line": 143,
        "column": 103,
        "method": "querySelector",
        "argument": "'[data-mail-log-fact=\"' + key + '\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-mail-log-dynamic-118"
        ]
      },
      {
        "line": 217,
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
    "sha256": "4456a01296601bbe329feb32572b386759a5806233608eb3a1c8cb345d59818c",
    "sites": [
      {
        "line": 134,
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
    "sha256": "5d3c90a7607f914fd93ce8f92c0da814aee7a64c007e3e9899a0a5e5ead330e5",
    "sites": [
      {
        "line": 66,
        "column": 95,
        "method": "querySelector",
        "argument": "'[data-whm-mail-queue-filter=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-mail-queue-dynamic-58"
        ]
      },
      {
        "line": 95,
        "column": 113,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 124,
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
    "sha256": "057f887ea903cc771626b52f19a4ff24de9a8f0f8ace3954a4a2f526b6775843",
    "sites": [
      {
        "line": 127,
        "column": 110,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 132,
        "column": 88,
        "method": "querySelector",
        "argument": "'[data-whm-mail-server-' + name + ']'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-mail-server-dynamic-107"
        ]
      },
      {
        "line": 146,
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
    "sha256": "894be7aa4ca7eaf3e537ac0a7fb6baacea12715fd317f1387902f46b53c82bbe",
    "sites": [
      {
        "line": 74,
        "column": 102,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-mailbox-maintenance-forwarded"
        ]
      },
      {
        "line": 101,
        "column": 122,
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
    "sha256": "b532db94ea03d172bf591552e48f1a615ac6b9fe190cbde2550cbc92e6da5d73",
    "sites": [
      {
        "line": 147,
        "column": 90,
        "method": "querySelector",
        "argument": "'[data-whm-metering-fact=\"' + key + '\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-metering-dynamic-58"
        ]
      },
      {
        "line": 149,
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
    "sha256": "9a5013c39b4c05edddaff56b842f1ce886b55fc622a52bb3fc738cc4cfa7c9f3",
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
    "sha256": "c3f3343eb72528cdef37d00068c384f801a8dc4f682dffec7f35ab0ccbd19602",
    "sites": [
      {
        "line": 150,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-monitoring-' + name + ']'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-monitoring-dynamic-118"
        ]
      },
      {
        "line": 181,
        "column": 121,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 402,
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
    "path": "apps/web/src/whm-network-client.ts",
    "sha256": "19edb08b0c2a492b9e6f79549593f6f0680a94d428966c0104fdaec41f222f1a",
    "sites": []
  },
  {
    "path": "apps/web/src/whm-panel-branding-client.ts",
    "sha256": "23040176e6c521a41eafe13f358c86db19bde5b18012790221f50c615b9498ab",
    "sites": [
      {
        "line": 38,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-panel-branding-forwarded"
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
    "sha256": "020b892d034ea37db2db16dc33c5b080f450eeb38eae687a86fb532dd291d41b",
    "sites": [
      {
        "line": 100,
        "column": 102,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-91"
        ]
      },
      {
        "line": 113,
        "column": 64,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "whm-php-workspace-controls"
        ]
      },
      {
        "line": 136,
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
        "line": 137,
        "column": 228,
        "method": "querySelectorAll",
        "argument": "'[data-php-action=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-141"
        ]
      },
      {
        "line": 269,
        "column": 65,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 270,
        "column": 100,
        "method": "querySelector",
        "argument": "'[data-php-action=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-141"
        ]
      },
      {
        "line": 274,
        "column": 52,
        "method": "querySelector",
        "argument": "'[data-whm-detail-section=\"' + section + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-144"
        ]
      },
      {
        "line": 338,
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
        "line": 343,
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
        "line": 437,
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
        "line": 464,
        "column": 176,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-276"
        ]
      },
      {
        "line": 470,
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
    "sha256": "6ed640633e558e5e330505f25db1515cf76f4a7d941f54b832ab7ef641018558",
    "sites": [
      {
        "line": 33,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-preferences-forwarded"
        ]
      },
      {
        "line": 40,
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
    "sha256": "6cab0b2890e298eb0f72b5a0a4ba04b51969d7f4e4b6e5ba919f63db052e977b",
    "sites": [
      {
        "line": 89,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-repair-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-repair-dynamic-84"
        ]
      },
      {
        "line": 96,
        "column": 110,
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
    "path": "apps/web/src/whm-security-client.ts",
    "sha256": "f8f11d53e44bbc6badf63a95b3728d02128f423e92bb23e9787614d0d0496581",
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
    "path": "apps/web/src/whm-security-tools-client.ts",
    "sha256": "59d39d6571c277c422fb3f8cb2569945a1987642c27ceef3f9ad656343b84aef",
    "sites": [
      {
        "line": 105,
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
        "line": 112,
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
    "path": "apps/web/src/whm-server-health-client.ts",
    "sha256": "4afe3c2e8d0578146f3990702e607f0d33615bd3d11fa11c77249a50048984d2",
    "sites": [
      {
        "line": 123,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-server-health-' + name + ']'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-server-health-dynamic-116"
        ]
      },
      {
        "line": 321,
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
    "sha256": "fd6aa55a4f11c731edaf5775d5d842fc1ef8aff12b39f63c9f519ad3351d9ec1",
    "sites": [
      {
        "line": 118,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-server-observation-' + name + ']'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-server-observation-dynamic-116"
        ]
      },
      {
        "line": 119,
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
    "sha256": "dff8f3bf2c1e700e4de79b69c12d7fdc08c7d1c5c26aee8184351a8cb9b5848e",
    "sites": [
      {
        "line": 114,
        "column": 137,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 139,
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
    "sha256": "be086a94fd112cd25c96a27078dcb60c04b9ff8fc2e9feecf00f1c5a284d457e",
    "sites": [
      {
        "line": 51,
        "column": 88,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-service-manager-forwarded"
        ]
      },
      {
        "line": 59,
        "column": 193,
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
    "sha256": "94bc9f26ebd7efff6892c51da6b7a3283b5ad9a33427a2df62b69934420d324f",
    "sites": [
      {
        "line": 84,
        "column": 88,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-software-center-forwarded"
        ]
      },
      {
        "line": 100,
        "column": 202,
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
    "path": "apps/web/src/whm-ssl-client.ts",
    "sha256": "e5574796a23cbe9c715d1eab8ab2f11d9538a8a8ccf6b921025075b71b1e17cc",
    "sites": [
      {
        "line": 81,
        "column": 86,
        "method": "querySelector",
        "argument": "'[data-ssl-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-ssl-dynamic-75"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-ssl-install-client.ts",
    "sha256": "4164bb7268bbde059edaacac20f2e26b61a3f3524c0e715db5fc3c1e947ae2e9",
    "sites": [
      {
        "line": 114,
        "column": 86,
        "method": "querySelector",
        "argument": "'[data-ssl-install-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-ssl-install-dynamic-108"
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
    "sha256": "d462863130bb6d9e44cc57449188d122a236387bcf1574f31aac2313b30abb93",
    "sites": [
      {
        "line": 87,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-support-forwarded"
        ]
      },
      {
        "line": 118,
        "column": 86,
        "method": "querySelector",
        "argument": "'[data-whm-support-fact=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-support-dynamic-93"
        ]
      },
      {
        "line": 121,
        "column": 39,
        "method": "querySelector",
        "argument": "'[data-whm-support-' + marker + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-support-dynamic-96"
        ]
      },
      {
        "line": 159,
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
    "sha256": "5b9beca3c99a72b69f5774e33d17a99bb9ce08722b71a78f3e0f9cda04b8efb5",
    "sites": [
      {
        "line": 37,
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
    "sha256": "fe1b7e1c5922a14c23b56278b29677c0757a063077e7097fa0c7a41a9783028d",
    "sites": [
      {
        "line": 38,
        "column": 90,
        "method": "querySelector",
        "argument": "'[data-transfer-field=\"' + id + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-transfer-dynamic-28"
        ]
      },
      {
        "line": 39,
        "column": 95,
        "method": "querySelector",
        "argument": "'[data-transfer-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-transfer-dynamic-29"
        ]
      },
      {
        "line": 105,
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
        "line": 288,
        "column": 65,
        "method": "querySelector",
        "argument": "`[data-transfer-import-${key}]`",
        "classification": "finite-owning-page-projection",
        "controllers": [
          "whm-transfer-import-projections"
        ]
      },
      {
        "line": 288,
        "column": 125,
        "method": "querySelector",
        "argument": "`[data-transfer-import-part=\"${key}\"] tbody`",
        "classification": "finite-owning-page-projection",
        "controllers": [
          "whm-transfer-import-projections"
        ]
      },
      {
        "line": 366,
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
    "sha256": "4d0aaae191fd75395f3c6204ed9c29af19581e614b5c7bc63985235c36d73283",
    "sites": [
      {
        "line": 63,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-whm-updates-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-updates-dynamic-58"
        ]
      },
      {
        "line": 68,
        "column": 110,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 87,
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
    "sha256": "ba52ee0252f5896cfcddc32cb155bcfe8ed6c2dc3f67d882aeb0cfd33373fff5",
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
    "sha256": "7e43030a28620f76e6c0c64d13edcf96a1660d3e61e68b7ce7e318f961b0bf98",
    "sites": [
      {
        "line": 90,
        "column": 64,
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
    "sha256": "df46cf95a9f1c93f688a9146e6b95954ef375462cd7ab4fabbae22b618d336b2",
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
    "path": "apps/web/src/ws-client.ts",
    "sha256": "0b47f17faafe8889698d987dcd04f2fcb3c5a69e0238ad9d92a55fbe6d5db099",
    "sites": [
      {
        "line": 692,
        "column": 41,
        "method": "querySelector",
        "argument": "'[data-stage=\"' + event.data.stage + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "reconcile-stage-projections"
        ]
      },
      {
        "line": 893,
        "column": 51,
        "method": "getElementById",
        "argument": "routeOrId.slice(1)",
        "classification": "source-classified",
        "controllers": [
          "shared-hash-navigation-id"
        ]
      },
      {
        "line": 954,
        "column": 69,
        "method": "querySelectorAll",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "account-creation-optional-selection"
        ]
      },
      {
        "line": 1166,
        "column": 63,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "account-creation-required-values"
        ]
      },
      {
        "line": 1412,
        "column": 77,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "userdata-config-fields"
        ]
      },
      {
        "line": 1749,
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
        "line": 1750,
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
        "line": 1790,
        "column": 43,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "tool-dialog-root-forwarder"
        ]
      },
      {
        "line": 1908,
        "column": 86,
        "method": "querySelector",
        "argument": "'[name=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-ip-config-fields"
        ]
      },
      {
        "line": 1912,
        "column": 72,
        "method": "querySelector",
        "argument": "'[name=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-ip-config-fields"
        ]
      },
      {
        "line": 1967,
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
    "path": "apps/web/src/account-gitweb-client.ts",
    "sha256": "b9d5342124a27a2facc9f43c5944e3872d9875028f4bc4431eec86a09da8e4d9",
    "sites": [
      {
        "line": 30,
        "column": 90,
        "method": "querySelector",
        "argument": "'[data-gitweb-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-gitweb"
        ]
      },
      {
        "line": 51,
        "column": 103,
        "method": "querySelector",
        "argument": "`[data-gitweb-fact=\"${key}\"]`",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-gitweb"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/email-disk-usage-client.ts",
    "sha256": "e1662815495bd63e09fa573261b7fea0f038604aae00c3897031cced89a0b12b",
    "sites": [
      {
        "line": 25,
        "column": 90,
        "method": "querySelector",
        "argument": "'[data-email-usage-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "email-disk-usage"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/file-share-links-client.ts",
    "sha256": "46e6ca912014c318a02111e3b1e2f653b6717546a6253ade35178d9849c4892a",
    "sites": [
      {
        "line": 28,
        "column": 90,
        "method": "querySelector",
        "argument": "'[data-file-share-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "file-share-links"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/service-users-client.ts",
    "sha256": "565f787c65c614419f496ab8308f1b63ecf94297e6788e6e395e47f242ffdd11",
    "sites": [
      {
        "line": 25,
        "column": 90,
        "method": "querySelector",
        "argument": "'[data-service-user-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "service-users"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-account-repair-client.ts",
    "sha256": "19347e0e075e39a2d8085ec99580e8e5d49f5a8374b92108dd6085f0cb1bebd2",
    "sites": [
      {
        "line": 18,
        "column": 90,
        "method": "querySelector",
        "argument": "'[data-account-repair-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "whm-account-repair"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-log-tools-client.ts",
    "sha256": "740eb8f7b5d5088f419a421926d1a5ec3947372133c4d586a2d06745708eef38",
    "sites": [
      {
        "line": 46,
        "column": 94,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "whm-log-tools"
        ]
      },
      {
        "line": 63,
        "column": 104,
        "method": "querySelector",
        "argument": "`[data-log-tools-fact=\"${name}\"]`",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "whm-log-tools"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/ctr-client.ts",
    "sha256": "0035fd3d5d41fd92f3b1527ca565e1ddc2d93024296a086b25bb1b0afa94323c",
    "sites": [
      {
        "line": 36,
        "column": 209,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      }
    ]
  }
]
