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
    "sha256": "fbceae69ed5dad7bdeaf7a2a2ec5492b6132402af635c5fc3d817868de0395dd",
    "sites": [
      {
        "line": 63,
        "column": 94,
        "method": "querySelector",
        "argument": "'[data-account-backup-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-backup"
        ]
      },
      {
        "line": 67,
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
    "sha256": "4e9eb0e8f16b647ff5a6017386e3782ef1254f171d41857463fbb49770ac6f30",
    "sites": [
      {
        "line": 94,
        "column": 135,
        "method": "querySelector",
        "argument": "'[data-cron-field=\"' + key + '\"]'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-cron"
        ]
      },
      {
        "line": 95,
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
    "sha256": "2233752a8c9008a5a509600a701d3dc966434c09ffc063a171e2a1421f4eb45a",
    "sites": [
      {
        "line": 59,
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
    "sha256": "57c5f5e2d0a3cd4bd0129a5b9a04c40decc525f0571ae0dacd91d13ea296f30b",
    "sites": [
      {
        "line": 55,
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
    "sha256": "6a1d1d36488cf57a86f853e20d18d4cce7ff4d9a077222da4a15645414745616",
    "sites": [
      {
        "line": 34,
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
    "sha256": "7289dc94b1f76a7a624f2192f23ffb8d21c672bdc037294ec2f6b329cfaaafe5",
    "sites": [
      {
        "line": 74,
        "column": 38,
        "method": "closest",
        "argument": "blockedAncestor",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 119,
        "column": 32,
        "method": "closest",
        "argument": "blockedAncestor",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 162,
        "column": 77,
        "method": "querySelector",
        "argument": "'[data-'+key+'-field=\"'+name+'\"]'",
        "classification": "finite-nested-client-row",
        "controllers": [
          "account-filters"
        ]
      },
      {
        "line": 167,
        "column": 105,
        "method": "closest",
        "argument": "blockedAncestor",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 203,
        "column": 60,
        "method": "closest",
        "argument": "blockedAncestor",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 204,
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
    "sha256": "33a3c57efe833d8c49d0c2971ef0e84608663d6be224b3fb7f7856b27bffb05c",
    "sites": [
      {
        "line": 67,
        "column": 52,
        "method": "querySelector",
        "argument": "`[data-${key}-status]`",
        "classification": "finite-nullable-section-key",
        "controllers": [
          "account-forwarders"
        ]
      },
      {
        "line": 72,
        "column": 117,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 75,
        "column": 38,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 82,
        "column": 98,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 276,
        "column": 59,
        "method": "querySelector",
        "argument": "`input[name=\"default-kind\"][value=\"${String(record?.kind ?? 'reject')}\"]`",
        "classification": "nullable-provider-row-lookup",
        "controllers": [
          "account-forwarders"
        ]
      },
      {
        "line": 284,
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
    "sha256": "bc1ea29666de115b38f438c4d50bd0c6151e0b50be16a00ae7da31bf8aaa9ba2",
    "sites": [
      {
        "line": 42,
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
    "sha256": "22fdecf71f3337a4df76d361a482d29c6ab967d02199168d9c05e3f043b8a13a",
    "sites": [
      {
        "line": 118,
        "column": 113,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 119,
        "column": 94,
        "method": "querySelector",
        "argument": "'[data-htaccess-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-htaccess"
        ]
      },
      {
        "line": 144,
        "column": 57,
        "method": "querySelector",
        "argument": "'[data-htaccess-php-' + name + ']'",
        "classification": "finite-nullable-preview",
        "controllers": [
          "account-htaccess"
        ]
      },
      {
        "line": 144,
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
    "sha256": "71af25a0eaf14bbbb0f620f5835414ffa969e205a72f4941eb95d9e9f350bc66",
    "sites": [
      {
        "line": 102,
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
    "sha256": "153d4c0fd169914d0ce8e9a8cd882d77bde7544ba809e190da3d5dd65e914933",
    "sites": [
      {
        "line": 54,
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
    "sha256": "0acbc98f2c462f7e0adc2e3ec271e7497daf52c29ce57c5d6085eb6812ac4c7e",
    "sites": [
      {
        "line": 93,
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
    "sha256": "f3d25d811c667083ac47986209979d6a9c25962fb3044ec14c3f8ef7ac1313cd",
    "sites": [
      {
        "line": 53,
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
    "sha256": "ce5272de9b41ba03e1720634fb77f84ad04f703fd89907537c27c0f9505bb1ca",
    "sites": [
      {
        "line": 34,
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
    "sha256": "76ff7b7be87b05d1a2577b6b7081d1fe8bad59dcbc4e37ffb5688dcb774c969f",
    "sites": [
      {
        "line": 24,
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
    "sha256": "f644e15e1cb9be0b976f051d6007980c33f045c5f828ad2ac12b1603d52bbfa7",
    "sites": [
      {
        "line": 26,
        "column": 95,
        "method": "querySelector",
        "argument": "'[data-quarantine-' + name + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-quarantine"
        ]
      },
      {
        "line": 29,
        "column": 85,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 48,
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
    "sha256": "7da3daf644d7622ef11b6497a241bcd155423eba65d19756b664db5bde969d48",
    "sites": [
      {
        "line": 71,
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
    "sha256": "fa3f3b40d371f5886dc924500e4c522531d7b6667fa04f5262c0a94364a4bf86",
    "sites": [
      {
        "line": 20,
        "column": 92,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-runtime"
        ]
      },
      {
        "line": 23,
        "column": 109,
        "method": "querySelector",
        "argument": "'[data-runtime-input=\"' + key + '\"]'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-runtime"
        ]
      },
      {
        "line": 25,
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
    "sha256": "68b2605517573354b1a99c33da09d32c240ba60c969a717023df09836fc5b584",
    "sites": [
      {
        "line": 70,
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
    "sha256": "2f7dde5d06fad73da859d16c73644a5ad972feb798dc106fb520b2d12501671d",
    "sites": [
      {
        "line": 57,
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
    "sha256": "b1f4ad473c24a1c361886e02ca305a461749c5e05e70a730395d19c92f223932",
    "sites": [
      {
        "line": 54,
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
    "sha256": "b1310203c638733f59c808ad711f9c4b6e8f156306f429ace1e5cbde27740ca9",
    "sites": [
      {
        "line": 40,
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
    "sha256": "705e9329a6711b08ca0d3d2562349130217c359265019cca151eed4184af210a",
    "sites": [
      {
        "line": 59,
        "column": 83,
        "method": "querySelector",
        "argument": "'[data-vscan-' + key + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-virus-scan"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/account-web-directives-client.ts",
    "sha256": "59bb37ff22645427375e83fe5921305611fda1ab38c6d7325340752c61901c02",
    "sites": [
      {
        "line": 149,
        "column": 88,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "account-web-directives"
        ]
      },
      {
        "line": 157,
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
    "sha256": "bcf38aec34f104c752b967f05516e9a0294f629ae3be93a9970abae6aeb28742",
    "sites": [
      {
        "line": 102,
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
    "sha256": "ec490fea0832fdb5c64d48266fb6b764998c0229c08b2574198ff3df324f8bcf",
    "sites": [
      {
        "line": 62,
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
    "sha256": "b86f3aecafff815b719fb662fb42354500ab8abe463f596cbb2187158d33eb05",
    "sites": [
      {
        "line": 49,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-enhancements"
        ]
      },
      {
        "line": 60,
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
    "sha256": "bf8bc6fab8231ba534fa6d77dd6a95aa7aad9c23c655cd913c3cc5ef5c5775b5",
    "sites": [
      {
        "line": 80,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-restore-more-' + name + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-restore"
        ]
      },
      {
        "line": 86,
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
    "sha256": "0f8309d007cc0c6386542f267ef1188298b28283c8b44268961218689dd63a78",
    "sites": [
      {
        "line": 49,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-staging-' + name + ']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-staging"
        ]
      },
      {
        "line": 55,
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
    "sha256": "583856d1b1a659d26fd9c579e08cb6c2b96e1b1e72a3442567ddf02e8c4c9f75",
    "sites": [
      {
        "line": 60,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-team"
        ]
      },
      {
        "line": 73,
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
    "sha256": "179b473afb9adaf16f47085a973760f2bde406222fd73ac0c5e90fcb5890bff2",
    "sites": [
      {
        "line": 41,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "acct-templates"
        ]
      },
      {
        "line": 51,
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
    "sha256": "ab862b8fb00b7d083858f26bd58fe59222f4c96e1a93b6233d89109ed719aded",
    "sites": [
      {
        "line": 9,
        "column": 71,
        "method": "closest",
        "argument": "unavailable",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 52,
        "column": 81,
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
    "sha256": "2722857264f1d30e18402465cf7b3ec11043c0f2a2855add9bd3d9d039f50526",
    "sites": [
      {
        "line": 73,
        "column": 51,
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
    "sha256": "92d45dd14d5ce25fdb8f504195386c381f2a6f43ca2b571d26e0f74f2da272b5",
    "sites": [
      {
        "line": 200,
        "column": 34,
        "method": "querySelector",
        "argument": "'[data-mail-recip=\"' + field + '\"]'",
        "classification": "finite-recipient-kind-controls",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 208,
        "column": 35,
        "method": "querySelector",
        "argument": "'[data-mail-recip=\"' + field + '\"] ul'",
        "classification": "finite-recipient-kind-controls",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 209,
        "column": 36,
        "method": "querySelector",
        "argument": "'[data-mail-recip-input=\"' + field + '\"]'",
        "classification": "finite-recipient-kind-controls",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 416,
        "column": 43,
        "method": "querySelectorAll",
        "argument": "'[data-mail-chip=\"' + field + '\"]'",
        "classification": "runtime-recipient-chip-collection",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 438,
        "column": 41,
        "method": "querySelectorAll",
        "argument": "'[data-mail-chip=\"' + field + '\"]'",
        "classification": "runtime-recipient-chip-collection",
        "controllers": [
          "mail-compose-recipient-controls"
        ]
      },
      {
        "line": 439,
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
    "sha256": "112b227343b84355b12feb07e547cc0ebd24e0099bc33894db58d33970b238f8",
    "sites": [
      {
        "line": 426,
        "column": 44,
        "method": "querySelector",
        "argument": "'[data-reading-id=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 430,
        "column": 45,
        "method": "querySelector",
        "argument": "'[data-mail-open=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 442,
        "column": 44,
        "method": "querySelector",
        "argument": "selector",
        "classification": "keyed-optional-runtime-reading-projection",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 655,
        "column": 53,
        "method": "querySelector",
        "argument": "'[data-mail-open=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 658,
        "column": 61,
        "method": "querySelector",
        "argument": "'[data-reading-id=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 792,
        "column": 53,
        "method": "querySelector",
        "argument": "'[data-mail-open=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 795,
        "column": 57,
        "method": "querySelector",
        "argument": "'[data-reading-id=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 796,
        "column": 56,
        "method": "querySelector",
        "argument": "'[data-reading-id=\"' + id + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 813,
        "column": 50,
        "method": "querySelector",
        "argument": "'[data-mail-count=\"' + counts[c].getAttribute('data-mail-count') + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 820,
        "column": 32,
        "method": "querySelector",
        "argument": "'[data-mail-count=\"' + observedCounts[n].getAttribute('data-mail-count') + '\"]'",
        "classification": "optional-keyed-runtime-or-provider-count-lookup",
        "controllers": [
          "mail-inbox-reading-projections"
        ]
      },
      {
        "line": 827,
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
    "sha256": "f04a01e474db902c21a0767433ef3eea8e6aadf5a3a664673091fb5cec9fb36a",
    "sites": [
      {
        "line": 1061,
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
        "line": 1062,
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
        "line": 1063,
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
        "line": 1064,
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
        "line": 1178,
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
        "line": 1296,
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
    "sha256": "69ab93209800baff598ad830ce348bbb9f34c41ef76c4cc715e8aa59d3445194",
    "sites": [
      {
        "line": 163,
        "column": 70,
        "method": "querySelector",
        "argument": "'[data-'+key+']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "database-workspace"
        ]
      },
      {
        "line": 205,
        "column": 114,
        "method": "querySelector",
        "argument": "'[name='+key+']'",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "database-workspace"
        ]
      },
      {
        "line": 207,
        "column": 143,
        "method": "querySelector",
        "argument": "selector",
        "classification": "finite-helper-or-variant-selector",
        "controllers": [
          "database-workspace"
        ]
      },
      {
        "line": 217,
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
    "sha256": "ec06c1854692e57c0cd4cb58126164e9f14280fa6953b138b04d67ad26014a68",
    "sites": [
      {
        "line": 113,
        "column": 115,
        "method": "querySelector",
        "argument": "'[data-db-fact=\"' + key + '\"]'",
        "classification": "finite-nullable-page-presentation",
        "controllers": [
          "db-engines"
        ]
      },
      {
        "line": 118,
        "column": 52,
        "method": "querySelector",
        "argument": "'[data-db-rows=\"' + name + '\"]'",
        "classification": "finite-nullable-page-presentation",
        "controllers": [
          "db-engines"
        ]
      },
      {
        "line": 207,
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
    "sha256": "20321b7dcf394409afa781513e9b71136ab6d5b2f6aacf5f9f9cb55dd2d30e66",
    "sites": [
      {
        "line": 143,
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
    "sha256": "928025df9b75e99fa2e82be8f904ef82d74cb0cf3e157e916b1a190629950e1d",
    "sites": [
      {
        "line": 131,
        "column": 96,
        "method": "querySelector",
        "argument": "'[name=\"'+name+'\"]'",
        "classification": "source-classified",
        "controllers": [
          "domain-create-fields"
        ]
      },
      {
        "line": 133,
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
    "sha256": "8427319f55dece21a8d9634916a46bc88ff5260f124930e6f110e8c44aa1dfe5",
    "sites": [
      {
        "line": 136,
        "column": 93,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 221,
        "column": 92,
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
    "sha256": "7f78849e7a7357fd39182fabf5ddcfc27714101c4858ff31ab429c5e3d538e5e",
    "sites": [
      {
        "line": 33,
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
        "line": 35,
        "column": 72,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "login-view-switches"
        ]
      },
      {
        "line": 285,
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
    "sha256": "e40baaae1328807f9ef570ebc7e71c5b9f50a7aeb4922dff21ba0a5966b6810e",
    "sites": [
      {
        "line": 34,
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
    "sha256": "7ff7bf8274b4375af251c6cc64af6835bf82ee1c77554db3e9bca0edb044226f",
    "sites": [
      {
        "line": 21,
        "column": 131,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 22,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-calendar-' + key + ']'",
        "classification": "source-classified",
        "controllers": [
          "mail-calendar-controls"
        ]
      },
      {
        "line": 23,
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
    "sha256": "d089bfe7d5ef3367a6f10df17dd6b84ee5950a8e3862c0d19499e7c397a82809",
    "sites": [
      {
        "line": 174,
        "column": 135,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 175,
        "column": 97,
        "method": "querySelector",
        "argument": "'[data-calview-' + key + ']'",
        "classification": "source-classified",
        "controllers": [
          "mail-calendar-view-controls"
        ]
      },
      {
        "line": 176,
        "column": 150,
        "method": "querySelector",
        "argument": "'[data-calview-field=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-calendar-view-controls"
        ]
      },
      {
        "line": 327,
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
    "sha256": "c3639fd4dcfe58f541dd5d1c4462a7f7e84de81a27a91551e378b46fb172415c",
    "sites": [
      {
        "line": 97,
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
    "sha256": "2c49f7ecef3722e20fddfd91931c68bd463d7c394513639aecc92a78dd6daaaf",
    "sites": [
      {
        "line": 86,
        "column": 135,
        "method": "querySelector",
        "argument": "'[data-contact-'+key+']'",
        "classification": "source-classified",
        "controllers": [
          "mail-contacts-buttons"
        ]
      },
      {
        "line": 93,
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
    "sha256": "21cda2a7c0bb70b2b5b6e884f992f3dce0d486e1c2d3a049bddc5bdf794c4bb0",
    "sites": [
      {
        "line": 195,
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
    "sha256": "0f443bb63ea54c54b6a100ad5525390a94a1cf9f54abde0346f067a154298958",
    "sites": [
      {
        "line": 59,
        "column": 171,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 61,
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
    "sha256": "4c91a5841463955b55dfa023585b89f76bf4a490ce852f533f4b89a33e1a566f",
    "sites": [
      {
        "line": 100,
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
    "sha256": "1728bc4fa7f3e29ba75186f11848d1b2e9c212a2588bd2e31523de543abfa622",
    "sites": [
      {
        "line": 42,
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
    "sha256": "8de1319e77ae56724686fd370744704b9d9cc3ef0a589a70df6a0748299ab999",
    "sites": [
      {
        "line": 61,
        "column": 77,
        "method": "querySelector",
        "argument": "`select[name=\"${name}\"]`",
        "classification": "source-classified",
        "controllers": [
          "mail-preferences-selects"
        ]
      },
      {
        "line": 65,
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
    "sha256": "30c6a3732f47d9b9cdb6c0b869b5ee0e77fa5494f7ceeb0183320d49805239de",
    "sites": [
      {
        "line": 66,
        "column": 88,
        "method": "querySelector",
        "argument": "'[data-mail-search-' + key + ']'",
        "classification": "source-classified",
        "controllers": [
          "mail-search-detail-fields"
        ]
      },
      {
        "line": 70,
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
    "sha256": "8749599e82dc5f6be9b2b54f8d1437d418d18d26697d0f93b81b53963666af74",
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
    "sha256": "34f850529f54632ffc8d60ce4567cd34825f7ab016f5325742dc38352e3476cb",
    "sites": [
      {
        "line": 62,
        "column": 165,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 64,
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
    "sha256": "06a13243469939d486a07880b906126a53d32a287491ca862b7014159f24faad",
    "sites": [
      {
        "line": 75,
        "column": 178,
        "method": "querySelector",
        "argument": "'[data-vacation-'+key+']'",
        "classification": "source-classified",
        "controllers": [
          "mail-vacation-buttons"
        ]
      },
      {
        "line": 83,
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
    "sha256": "e7a1b397344b233dce79d44c79f59c2d70114824d3e19e9082d8aceabc59c13f",
    "sites": [
      {
        "line": 53,
        "column": 113,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 56,
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
    "sha256": "760088145993d5a82974a627a79c2c5e4301fa58a9c3a2c8d32352a5b088b8e5",
    "sites": [
      {
        "line": 45,
        "column": 82,
        "method": "querySelector",
        "argument": "'[data-mailx-' + key + ']'",
        "classification": "source-classified",
        "controllers": [
          "mailx-collections-controls"
        ]
      },
      {
        "line": 53,
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
    "sha256": "8262757b41a1074693994bc2a2058aabe7cfc58b9780878213172646ec40a0f5",
    "sites": [
      {
        "line": 84,
        "column": 113,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 86,
        "column": 103,
        "method": "querySelector",
        "argument": "'[data-mailx-tools-fact=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mailx-list-delivery-facts"
        ]
      },
      {
        "line": 138,
        "column": 113,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 140,
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
    "sha256": "00280353b1f8b4fdb150730f60086a5ede2879c3462b2859306af5cec99d8d05",
    "sites": [
      {
        "line": 48,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-ops-shares-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-file-sharing-dynamic-48"
        ]
      },
      {
        "line": 53,
        "column": 147,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 57,
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
    "sha256": "b6b225a60a969c531b256a13b651914cd1504f29291f0b21b4f1753e1486233d",
    "sites": [
      {
        "line": 48,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-ops-int-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-integrations-dynamic-48"
        ]
      },
      {
        "line": 52,
        "column": 144,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 56,
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
    "sha256": "bdf0cd8a6f0817ed9edce0c300ad5e433ec923bdfe6ec2eb18fb68fbfd141697",
    "sites": [
      {
        "line": 36,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-ops-nodes-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-nodes-dynamic-36"
        ]
      },
      {
        "line": 37,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-ops-nodes-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "ops-nodes-dynamic-37"
        ]
      },
      {
        "line": 42,
        "column": 146,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 47,
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
    "sha256": "8922959993e1b208d4e52ef45210aafb7f341c111ec7883133206666d482e119",
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
    "sha256": "19dfc335dfaa54a38583cf83f4b7591268b58f28907ac658bb43ed2f60d10ae8",
    "sites": [
      {
        "line": 43,
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
        "line": 44,
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
        "line": 47,
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
    "path": "apps/web/src/site-health-client.ts",
    "sha256": "98a570a77084a7444e2ace66b86444382e71d3c53f43d22d6429deff1c1101b4",
    "sites": [
      {
        "line": 52,
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
    "sha256": "47b3e8f75b6502b34f69c94991e67ed09057aab991dd1ff130f2e3360ab0f707",
    "sites": [
      {
        "line": 31,
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
    "sha256": "6b6db31b1cafebf8c462fd3f84353605f72f632e29cd71d17fd95e7462341591",
    "sites": [
      {
        "line": 31,
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
    "sha256": "713b6f40cb01b7c93df4e5b8aa61aa38e1f88fad853779d7e1c5323c0b0b47b1",
    "sites": [
      {
        "line": 24,
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
    "sha256": "73ab50a94f5883863d59b088fff2a17c9b418670dfccc1b986dbe7cf8293cccd",
    "sites": [
      {
        "line": 43,
        "column": 87,
        "method": "querySelector",
        "argument": "'[data-sw-dep-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "sw-deployments-dynamic-43"
        ]
      },
      {
        "line": 46,
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
    "sha256": "4267e8109581bf81ff32b0b91119d40235e387fceaec9476f78cae0a6fd4f5be",
    "sites": [
      {
        "line": 16,
        "column": 108,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 18,
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
    "sha256": "353a7d7362389ffd27be2235a1e26ff322c140b1a6d6eadb8b34b5da4f08f5cb",
    "sites": [
      {
        "line": 71,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-health-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-account-health-dynamic-71"
        ]
      },
      {
        "line": 77,
        "column": 147,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 224,
        "column": 115,
        "method": "querySelector",
        "argument": "'[data-whm-health-account=\"' + account.username + '\"]'",
        "classification": "runtime-generated-optional",
        "controllers": [
          "whm-account-health-dynamic-224"
        ]
      },
      {
        "line": 266,
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
    "sha256": "1f35d29593392eb3e3ddf242b91e11db0bd79ef7ec94d0d579410fd3dc1c59a1",
    "sites": [
      {
        "line": 66,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-announcements-forwarded"
        ]
      },
      {
        "line": 78,
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
    "path": "apps/web/src/whm-backup-destinations-client.ts",
    "sha256": "eb2311da4d587423240e5b6a4606b287f4fb192b7e76ff3acbc2689c1b8e51e7",
    "sites": [
      {
        "line": 43,
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
    "sha256": "a1e2dd6191a70b8ae218d82acbc1905be582c0cac4aa1ab23434385f115018a3",
    "sites": [
      {
        "line": 80,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-backup-files-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backup-files-dynamic-80"
        ]
      },
      {
        "line": 87,
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
    "path": "apps/web/src/whm-backups-client.ts",
    "sha256": "ad43644c54317b57fbe8a16c46697065c960eeae177530c0e509c0956793c8ac",
    "sites": [
      {
        "line": 104,
        "column": 91,
        "method": "querySelector",
        "argument": "'#backup-layout-' + key",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backups-dynamic-104"
        ]
      },
      {
        "line": 105,
        "column": 94,
        "method": "querySelector",
        "argument": "'#backup-layout-' + key",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backups-dynamic-105"
        ]
      },
      {
        "line": 106,
        "column": 94,
        "method": "querySelector",
        "argument": "'[data-backup-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-backups-dynamic-106"
        ]
      },
      {
        "line": 108,
        "column": 111,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 368,
        "column": 111,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 370,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-backups-forwarded"
        ]
      },
      {
        "line": 371,
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
    "sha256": "2405e36e530615821f9bc1376353c8fc0dc49961a611512b37db89d6183ba3e5",
    "sites": [
      {
        "line": 22,
        "column": 114,
        "method": "closest",
        "argument": "blocked",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 29,
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
    "sha256": "6ea9fa64434f40942a24f760b98949fa10570063fcdb6c9b9f82e8ea91178d5a",
    "sites": [
      {
        "line": 87,
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
    "sha256": "b6de816472b342b45ead19ea66b43027f39716fd4d30391e6216d941ab5ecae5",
    "sites": [
      {
        "line": 123,
        "column": 108,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 136,
        "column": 54,
        "method": "querySelector",
        "argument": "'[data-whm-db-fact=\"' + key + '\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-databases-dynamic-136"
        ]
      },
      {
        "line": 143,
        "column": 89,
        "method": "querySelector",
        "argument": "'[data-whm-db-rows=\"' + name + '\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-databases-dynamic-143"
        ]
      }
    ]
  },
  {
    "path": "apps/web/src/whm-developer-client.ts",
    "sha256": "50ea9288dca19fe7cb0cfd21f051173f132cc4ca1b9d26d9e4cb1fadef6733f4",
    "sites": [
      {
        "line": 53,
        "column": 95,
        "method": "querySelector",
        "argument": "s",
        "classification": "source-classified",
        "controllers": [
          "whm-developer-forwarded"
        ]
      },
      {
        "line": 58,
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
    "path": "apps/web/src/whm-dns-client.ts",
    "sha256": "a38401ce44a95fcb5816c9ce30013930cf19ee762a30078242c550a30891389f",
    "sites": [
      {
        "line": 23,
        "column": 94,
        "method": "querySelector",
        "argument": "'[data-dns-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-dns-dynamic-23"
        ]
      },
      {
        "line": 27,
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
    "sha256": "d64498acd3f64eb3050200c15c78977978ddd5d391bf476857e1fbe7c693d4f6",
    "sites": [
      {
        "line": 113,
        "column": 102,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-dns-tools-forwarded"
        ]
      },
      {
        "line": 119,
        "column": 114,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 160,
        "column": 106,
        "method": "querySelectorAll",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-dns-tools-forwarded"
        ]
      },
      {
        "line": 166,
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
    "sha256": "28c714065ff73d671058f739067b3d714b062ee4d1c4dbf29c9bfacf46d326d5",
    "sites": [
      {
        "line": 117,
        "column": 60,
        "method": "querySelector",
        "argument": "'[data-whm-firewall-panel=\"' + kind + '\"] table'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-firewall-dynamic-117"
        ]
      },
      {
        "line": 164,
        "column": 150,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-firewall-dynamic-164"
        ]
      },
      {
        "line": 172,
        "column": 68,
        "method": "querySelector",
        "argument": "'[data-firewall-action=\"' + hookName + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-firewall-dynamic-172"
        ]
      },
      {
        "line": 175,
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
    "sha256": "14c4592cd07f1511ee28bd6627537d49349115825f764ba9f34048f46d802a4c",
    "sites": [
      {
        "line": 114,
        "column": 112,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 115,
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
    "sha256": "59860c5db07a4a9ba6d0184105956efd9456d03e6b2526dc7872e8701a2ff19c",
    "sites": [
      {
        "line": 60,
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
    "sha256": "0b115556c8140d1a925b3495b658b1f8b2f67538fad61f6c0993f920e9d5f4d1",
    "sites": [
      {
        "line": 69,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-jobs-forwarded"
        ]
      },
      {
        "line": 80,
        "column": 110,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 119,
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
    "sha256": "54c4cf95674ff5954dc35080f91b495ab4f4e5924610ffa0a7d1a9a1c9d96d3c",
    "sites": [
      {
        "line": 117,
        "column": 113,
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
        "argument": "'[data-mail-log-fact=\"' + key + '\"]'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-mail-log-dynamic-118"
        ]
      },
      {
        "line": 192,
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
    "sha256": "07b0048d51c638b0718b677337149931660120ae03b065ae48feb69c2ab1394f",
    "sites": [
      {
        "line": 81,
        "column": 117,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 109,
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
    "sha256": "a753f39d4defd2efc0386569b77dd09e8a240423e7b9353afa27cfc42bc94591",
    "sites": [
      {
        "line": 58,
        "column": 95,
        "method": "querySelector",
        "argument": "'[data-whm-mail-queue-filter=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-mail-queue-dynamic-58"
        ]
      },
      {
        "line": 62,
        "column": 115,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 92,
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
    "sha256": "8142c029835957c7886fb9fdc8f68e789a6a0ffa815c6a529c50be3b331cd368",
    "sites": [
      {
        "line": 97,
        "column": 116,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 107,
        "column": 88,
        "method": "querySelector",
        "argument": "'[data-whm-mail-server-' + name + ']'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-mail-server-dynamic-107"
        ]
      },
      {
        "line": 121,
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
    "sha256": "3a709e0f61e78d0321cc1667b31928ae051b0ca258296dc77daa481dc62c417f",
    "sites": [
      {
        "line": 66,
        "column": 102,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-mailbox-maintenance-forwarded"
        ]
      },
      {
        "line": 72,
        "column": 124,
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
    "sha256": "4d0ef441cd7a18f5fcc3a69c7d816dbf28b655c6142abc922eb52b6108b37d10",
    "sites": [
      {
        "line": 112,
        "column": 104,
        "method": "querySelector",
        "argument": "'[data-whm-alerts-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-monitoring-alerts-dynamic-112"
        ]
      },
      {
        "line": 119,
        "column": 108,
        "method": "querySelector",
        "argument": "'[data-whm-alerts-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-monitoring-alerts-dynamic-119"
        ]
      },
      {
        "line": 122,
        "column": 114,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 128,
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
    "sha256": "1890aa50706dabdd1d7ba64aeebaa8396009744d87a710c29eb8662b3e24a8b4",
    "sites": [
      {
        "line": 116,
        "column": 151,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 118,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-monitoring-' + name + ']'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-monitoring-dynamic-118"
        ]
      },
      {
        "line": 340,
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
    "sha256": "a3a900a710e6762bd41daee170b75dfb51ae9b9e8fa9059dfa2a53695220beb4",
    "sites": [
      {
        "line": 20,
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
    "path": "apps/web/src/whm-panel-notifications-client.ts",
    "sha256": "15984d9f8ecb9d28c7f44b32d0ebe5cbd2aa170d4453485edd5b0093f608a8c5",
    "sites": [
      {
        "line": 57,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-panel-notifications-forwarded"
        ]
      },
      {
        "line": 67,
        "column": 121,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 71,
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
    "sha256": "4297f6ad16a13c296796706203af2fc4e92257b76d98e240ff0f1f09765df1c2",
    "sites": [
      {
        "line": 53,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-panel-tokens-forwarded"
        ]
      },
      {
        "line": 64,
        "column": 114,
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
    "sha256": "7735cf18678c124a1ecaf43425cffa213f883c342113cd4437b6dbfd4454f159",
    "sites": [
      {
        "line": 86,
        "column": 100,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 91,
        "column": 102,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-91"
        ]
      },
      {
        "line": 141,
        "column": 100,
        "method": "querySelector",
        "argument": "'[data-php-action=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-141"
        ]
      },
      {
        "line": 144,
        "column": 52,
        "method": "querySelector",
        "argument": "'[data-whm-detail-section=\"' + section + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-144"
        ]
      },
      {
        "line": 201,
        "column": 91,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-201"
        ]
      },
      {
        "line": 248,
        "column": 91,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-248"
        ]
      },
      {
        "line": 276,
        "column": 176,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-php-dynamic-276"
        ]
      },
      {
        "line": 282,
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
    "sha256": "0dedb760696bab931426cbd7b3525955b082debc19f3fc3e7b463a55fa77bdc4",
    "sites": [
      {
        "line": 84,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-repair-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-repair-dynamic-84"
        ]
      },
      {
        "line": 90,
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
    "sha256": "366b7ea1088bbc8816e9bc4200c61c9f87e1b90a7a533f565397d87062004900",
    "sites": [
      {
        "line": 100,
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
        "line": 105,
        "column": 119,
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
    "sha256": "2fae9c0a7f03372acc293f5ee7f2c683deef07b48dad5d37dcf734de6794e01b",
    "sites": [
      {
        "line": 116,
        "column": 91,
        "method": "querySelector",
        "argument": "'[data-whm-server-health-' + name + ']'",
        "classification": "finite-conditional-required",
        "controllers": [
          "whm-server-health-dynamic-116"
        ]
      },
      {
        "line": 119,
        "column": 153,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 299,
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
    "sha256": "0319ac2e7d69ffeade3f901931c172e5f0221ca76972c073892249110e1d3868",
    "sites": [
      {
        "line": 101,
        "column": 119,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 108,
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
    "sha256": "0ada57a11853517b4b1da9727bab937c395e16d8ef25a4d8e39142d904884f10",
    "sites": [
      {
        "line": 44,
        "column": 88,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-service-manager-forwarded"
        ]
      },
      {
        "line": 50,
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
    "path": "apps/web/src/whm-software-center-client.ts",
    "sha256": "05a8c48b6750285259020b5cbd5b0fd882479ebcb9450aba7f8dad6235469bcb",
    "sites": [
      {
        "line": 75,
        "column": 88,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-software-center-forwarded"
        ]
      },
      {
        "line": 83,
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
    "sha256": "c3b7acc80b7e48b4b358f137d3ecebdb51059d1fd7f5cf70c088b0e87dbe1dc1",
    "sites": [
      {
        "line": 75,
        "column": 86,
        "method": "querySelector",
        "argument": "'[data-ssl-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-ssl-dynamic-75"
        ]
      },
      {
        "line": 82,
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
    "sha256": "b1e6ba194e201504903bbb2f8db072aafec10bf3a5754e6526fd45ba56767dd5",
    "sites": [
      {
        "line": 108,
        "column": 86,
        "method": "querySelector",
        "argument": "'[data-ssl-install-' + key + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-ssl-install-dynamic-108"
        ]
      },
      {
        "line": 116,
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
    "sha256": "68f2eacf854f55ccb05b14b4674d10ea10b074056e02b4d337e109d77fcfbd40",
    "sites": [
      {
        "line": 63,
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
    "sha256": "e9fe2ac640f8a9afabcc1771b851d4e63e9717325b399416417f4cf5d5471703",
    "sites": [
      {
        "line": 82,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-support-forwarded"
        ]
      },
      {
        "line": 88,
        "column": 113,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 93,
        "column": 86,
        "method": "querySelector",
        "argument": "'[data-whm-support-fact=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-support-dynamic-93"
        ]
      },
      {
        "line": 96,
        "column": 39,
        "method": "querySelector",
        "argument": "'[data-whm-support-' + marker + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-support-dynamic-96"
        ]
      },
      {
        "line": 134,
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
    "sha256": "ddb9ebd1aaac9ab34319a029ff5a244ef8e7828f687ee62528e1769b8d552887",
    "sites": [
      {
        "line": 28,
        "column": 90,
        "method": "querySelector",
        "argument": "'[data-transfer-field=\"' + id + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-transfer-dynamic-28"
        ]
      },
      {
        "line": 29,
        "column": 95,
        "method": "querySelector",
        "argument": "'[data-transfer-' + name + ']'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-transfer-dynamic-29"
        ]
      },
      {
        "line": 49,
        "column": 113,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 213,
        "column": 41,
        "method": "querySelector",
        "argument": "'[data-whm-detail-section=\"' + key + '\"] table tbody'",
        "classification": "finite-source-classified",
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
    "sha256": "55a8be0570a7357c6993536837f12f048ff49840e6e8a3c916914c5ebbc991e0",
    "sites": [
      {
        "line": 58,
        "column": 101,
        "method": "querySelector",
        "argument": "'[data-whm-updates-action=\"' + key + '\"]'",
        "classification": "finite-source-classified",
        "controllers": [
          "whm-updates-dynamic-58"
        ]
      },
      {
        "line": 62,
        "column": 148,
        "method": "closest",
        "argument": "denied",
        "classification": "literal-ineligibility-ancestor-policy",
        "controllers": [
          "ancestor-eligibility-policy"
        ]
      },
      {
        "line": 83,
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
    "sha256": "ff2abf8ebff6094e9c73c1d23f63541aa30a4e74b6fba3096db4a74fe4ce4002",
    "sites": [
      {
        "line": 62,
        "column": 90,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "whm-whmcs-forwarded"
        ]
      },
      {
        "line": 76,
        "column": 140,
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
    "sha256": "c93196af16afd01a876b373b1c86402a859622a514435e2a3f2ec651256e8351",
    "sites": [
      {
        "line": 628,
        "column": 41,
        "method": "querySelector",
        "argument": "'[data-stage=\"' + event.data.stage + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "reconcile-stage-projections"
        ]
      },
      {
        "line": 774,
        "column": 65,
        "method": "querySelectorAll",
        "argument": "focusableSelector",
        "classification": "source-classified",
        "controllers": [
          "overlay-focus-policy"
        ]
      },
      {
        "line": 805,
        "column": 36,
        "method": "matches",
        "argument": "focusableSelector",
        "classification": "source-classified",
        "controllers": [
          "shared-focus-selector-match"
        ]
      },
      {
        "line": 1102,
        "column": 51,
        "method": "getElementById",
        "argument": "routeOrId.slice(1)",
        "classification": "source-classified",
        "controllers": [
          "shared-hash-navigation-id"
        ]
      },
      {
        "line": 1156,
        "column": 69,
        "method": "querySelectorAll",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "account-creation-optional-selection"
        ]
      },
      {
        "line": 1306,
        "column": 63,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "account-creation-required-values"
        ]
      },
      {
        "line": 1532,
        "column": 77,
        "method": "querySelector",
        "argument": "'[name=\"' + name + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "userdata-config-fields"
        ]
      },
      {
        "line": 1932,
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
        "line": 1933,
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
        "line": 1973,
        "column": 43,
        "method": "querySelector",
        "argument": "selector",
        "classification": "source-classified",
        "controllers": [
          "tool-dialog-root-forwarder"
        ]
      },
      {
        "line": 2091,
        "column": 86,
        "method": "querySelector",
        "argument": "'[name=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-ip-config-fields"
        ]
      },
      {
        "line": 2095,
        "column": 72,
        "method": "querySelector",
        "argument": "'[name=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-ip-config-fields"
        ]
      },
      {
        "line": 2150,
        "column": 60,
        "method": "querySelector",
        "argument": "'[name=\"' + key + '\"]'",
        "classification": "source-classified",
        "controllers": [
          "mail-ip-config-fields"
        ]
      }
    ]
  }
]
