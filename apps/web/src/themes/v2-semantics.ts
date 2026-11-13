import { checkConformance, routeContracts, type HookRequirement } from './contract.ts'
import { isHtmlElement, markupNodeSpan, matchesHook, parseMarkup, type HookSelector, type MarkupNode } from './markup.ts'
import { isLocale, translator } from '../i18n.ts'
import { escapeHtml } from '../html.ts'
import { msgctxt } from '@xpanel/core'
import type { ControllerDeclaration } from './controller-conformance.ts'

/** The Classic observation registry remains unchanged. These are explicit semantic counterparts,
 * not a generated V2 snapshot. Every original controller and template requirement is retained. */
export const V2_SHARED_CHROME_REQUIREMENTS: readonly ControllerDeclaration[] = [
  { id: 'v2-semantic-document', rootSelector: 'html', rootRequired: true,
    rootAttributes: { 'data-ui-theme': 'v2', lang: { oneOf: ['en', 'ar'] }, dir: { oneOf: ['ltr', 'rtl'] }, 'data-theme': { oneOf: ['light', 'dark'] } } },
  { id: 'v2-semantic-banner', rootSelector: 'header[role="banner"]', rootRequired: true,
    parentRootSelector: '[data-xp-shell-content]', rootAttributes: { hidden: false, inert: false, 'aria-hidden': { not: 'true' } },
    requiredSelectors: ['[data-ws-indicator]'] },
  { id: 'v2-semantic-live-status', rootSelector: 'span[data-ws-indicator]', rootRequired: true,
    parentRootSelector: 'header[role="banner"]',
    rootAttributes: { role: 'status', 'data-ws-indicator': { oneOf: ['connected', 'disconnected', 'unavailable'] }, hidden: false, inert: false, 'aria-hidden': { not: 'true' } },
    requiredSelectors: ['[data-ws-label="connected"]', '[data-ws-label="disconnected"]', '[data-ws-label="unavailable"]'],
    elements: ['connected', 'disconnected', 'unavailable'].map(state => ({ selector: '[data-ws-label="' + state + '"]', tags: ['span'],
      attributes: { hidden: false, inert: false, 'aria-hidden': { not: 'true' } }, occurrence: 'every' as const })) },
]

interface ObservationCounterpart {
  readonly route: string
  readonly legacyHook: HookSelector
  readonly requirement: ControllerDeclaration
  readonly evidence: string
}
const native = (route: string, rootSelector: string, evidence: string, requiredSelectors: readonly string[] = []): ObservationCounterpart => ({
  route, legacyHook: '[data-wiring="soon"]', evidence,
  requirement: { id: 'v2-semantic-workspace:' + route, rootSelector, rootRequired: true, applicableRoutes: [route], requiredSelectors },
})
const analytics = (route: string): ObservationCounterpart => ({
  route, legacyHook: '[data-wiring="soon"]',
  evidence: 'V2 observations/traffic.ts validates account/domain snapshots, publishes readState and preserves a GET-only selection form; missing data is not zero.',
  requirement: { id: 'v2-semantic-analytics:' + route, rootSelector: '[data-surface-widget="website-analytics"]', rootRequired: true, applicableRoutes: [route],
    rootAttributes: { 'data-chart-state': { oneOf: ['unread', 'unavailable', 'empty', 'loaded'] } },
    requiredSelectors: ['section[aria-labelledby="v2-traffic-selection-heading"] h2#v2-traffic-selection-heading', 'section[aria-labelledby="v2-traffic-requests-heading"] h2#v2-traffic-requests-heading', 'section[aria-labelledby="v2-traffic-visitors-heading"] h2#v2-traffic-visitors-heading'],
    elements: [{ selector: 'form', tags: ['form'], attributes: { method: 'get', action: route }, occurrence: 'every', required: false }] },
})
/** The classic page no longer holds a placeholder to replace, so V2 keeps this as a route requirement of its own. */
export const V2_WEB_STATS_REQUIREMENT: ControllerDeclaration = { id: 'v2-semantic-web-stats:/metrics/web-stats', rootSelector: '[data-surface-widget="web-stats"]', rootRequired: true, applicableRoutes: ['/metrics/web-stats'],
  rootAttributes: { 'data-chart-state': { oneOf: ['unread', 'unavailable', 'empty', 'loaded'] } },
  requiredSelectors: ['section[aria-labelledby="v2-web-stats-selection-heading"] h2#v2-web-stats-selection-heading', 'section[aria-labelledby="v2-web-stats-days-heading"] h2#v2-web-stats-days-heading', 'section[aria-labelledby="v2-web-stats-engines-heading"] h2#v2-web-stats-engines-heading'],
  elements: [{ selector: 'form', tags: ['form'], attributes: { method: 'get', action: '/metrics/web-stats' }, occurrence: 'every', required: false }] }
const store = (route: string): ObservationCounterpart => ({
  route, legacyHook: '[data-wiring="unavailable"]',
  evidence: 'V2 software/catalog.ts renderV2WhmStore: installer absent; data-installer-state=unavailable on its visible status, with all approved action buttons disabled by common.button default.',
  requirement: { id: 'v2-semantic-installer:' + route, rootSelector: '[data-store-workspace]', rootRequired: true, applicableRoutes: [route],
    rootAttributes: { 'data-whm-detail-route': route }, requiredSelectors: ['[data-installer-state="unavailable"]', '[data-store-fact]', 'button'],
    elements: [{ selector: '[data-installer-state="unavailable"]', tags: ['p'], attributes: { role: 'status', hidden: false }, occurrence: 'every' },
      { selector: 'button', tags: ['button'], attributes: { type: 'button', disabled: true }, occurrence: 'every' }] },
})

/** Each replaced wiring observation has a real source-owned counterpart. Never mark an operational
 * Files/Services ancestor as soon: those clients correctly deny such ancestors. */
export const V2_OBSERVATION_COUNTERPARTS: readonly ObservationCounterpart[] = [
  native('/resources', '[data-resource-observation]', 'V2 resources shows saved limits and marks each observation unread; it holds no refresh control without a reader.'),
  native('/domains/zone-editor', '[data-dns-editor]', 'dns client zone-editor declaration remains required'),
  native('/email/accounts', 'form[data-mailbox-form]', 'ws-client mailbox form + password/quota declarations remain required', ['[name="domainId"]', '[name="localPart"]', '[name="password"]', '[data-mailbox-status]']),
  native('/files/backup', '[data-account-backup]', 'account-backup-client.ts and independent account-backup declaration'),
  native('/files/trash', '[data-file-manager="trash"]', 'file-workspace-client.ts:340-357; preserve its exact identity, revision, readback and denied-ancestor guards'),
  analytics('/metrics/traffic'),
  native('/security/account', 'section[data-account-security="two-factor"]', 'core accountSecurity slot + optional, disabled-development and handed-off forms remain governed by original independent declarations'),
  native('/software/php', 'form[data-domain-php-form]', 'V2 software/php.ts real stored domain PHP editor and existing core client fields', ['[name="domainId"]', '[name="version"]', '[name="handler"]', '[name="fpm.mode"]', '[data-domain-php-status]']),
  native('/whm/security/firewall', '[data-approved-whm-operations="/whm/security/firewall"]', 'whm-firewall-client and existing qualified/denied conditional table/editor declarations'),
  native('/whm/services', '[data-host-services]', 'host-services client and existing approved-host-services declaration; no qualification changes'),
  ...['/whm/software/site-software', '/whm/software/store', '/whm/software/store/activity', '/whm/software/store/extensions'].map(store),
]

/** Exact Classic-only split/filter/drawer observations. Real announcement hooks and data-state stay required. */
export const V2_HOME_OBSERVATION_HOOKS: readonly HookSelector[] = ['#m-filter', '#xpanel-home-drawer-host', '[data-board-port="xpanel-home"]', '[data-home-action="toggle-group"]', '[data-home-action]', '[data-home-desktop]', '[data-home-phone]', '[data-home-main="desktop"]', '[data-home-main="phone"]', '[data-show]', '[data-user-open]']
const homeRequirement: ControllerDeclaration = { id: 'v2-semantic-home-tools', rootSelector: '[data-panel-home]', rootRequired: true, applicableRoutes: ['/home'],
  requiredSelectors: ['input#tool-filter[data-home-filter]', '#tool-filter-count', '[data-tool-section]', '[data-tool-empty]', 'details[data-home-accordion] > summary', '[data-tool-panel]'] }
const extraObservations: readonly ObservationCounterpart[] = [
  ...['/mail/inbox', '/mail/sent', '/mail/drafts', '/mail/trash'].map(route => ({ route, legacyHook: '[data-total]' as const,
    evidence: 'V2 inbox emits data-total only for a known total, always data-loaded/data-rest on the actual pager. Core tolerates absent total.',
    requirement: { id: 'v2-semantic-mail-count:' + route, rootSelector: 'span[data-mail-pager]', rootRequired: true, applicableRoutes: [route], parentRootSelector: '[data-mail-folder-workspace]', rootAttributes: { 'data-loaded': true, 'data-rest': true } } })),
  { route: '/whm/software/php', legacyHook: '[data-php-extension-draft-grid]', evidence: 'whm-php-client.ts287-303 fills the real extensions table and typed switch;304 only hides the optional legacy draft.',
    requirement: { id: 'v2-semantic-php-extension-table', rootSelector: '[data-whm-detail-section="php-extensions"]', rootRequired: true, applicableRoutes: ['/whm/software/php'], requiredSelectors: ['tbody'] } },
]
/** Finite loaded-state counterparts traced to the actual metering/network/terminal/generation consumers. */
export const V2_STATEFUL_OBSERVATION_COUNTERPARTS: readonly ObservationCounterpart[] = [
  {
    "route": "/whm/accounts/bandwidth",
    "legacyHook": "[data-numeric]",
    "requirement": {
      "rootSelector": "[data-whm-metering=\"bandwidth\"]",
      "rootRequired": true,
      "rootAttributes": {
        "data-metering-can-read": {
          "oneOf": [
            "true",
            "false"
          ]
        }
      },
      "elements": [
        {
          "selector": "[data-whm-metering-refresh]",
          "tags": [
            "button"
          ]
        },
        {
          "selector": "[data-whm-metering-status]",
          "attributes": {
            "data-state": true,
            "role": {
              "oneOf": [
                "status",
                "alert"
              ]
            }
          },
          "tags": [
            "p"
          ]
        },
        {
          "selector": "[data-whm-metering-rows=\"bandwidth\"]",
          "tags": [
            "tbody"
          ]
        }
      ],
      "id": "v2-semantic-bandwidth-numeric",
      "requiredSelectors": [
        "[data-whm-metering-refresh]",
        "[data-whm-metering-status]",
        "tbody[data-whm-metering-rows=\"bandwidth\"]"
      ],
      "applicableRoutes": [
        "/whm/accounts/bandwidth"
      ]
    },
    "evidence": "whm-metering-client.ts:50-68,108-128; V2 account-tools/pages.ts:35-50"
  },
  {
    "route": "/whm/server/networking",
    "legacyHook": "[data-numeric]",
    "requirement": {
      "rootSelector": "[data-whm-server-observation=\"network\"]",
      "rootRequired": true,
      "rootAttributes": {
        "data-server-observation-can-read": {
          "oneOf": [
            "true",
            "false"
          ]
        }
      },
      "elements": [
        {
          "selector": "[data-whm-server-observation-refresh]",
          "tags": [
            "button"
          ]
        },
        {
          "selector": "[data-whm-server-observation-status]",
          "attributes": {
            "data-state": true,
            "role": {
              "oneOf": [
                "status",
                "alert"
              ]
            }
          },
          "tags": [
            "p"
          ]
        },
        {
          "selector": "[data-whm-server-observation-interface-rows],[data-whm-server-observation-pool-rows],[data-whm-server-observation-unpooled-rows],[data-whm-server-observation-route-rows]",
          "occurrence": "every",
          "tags": [
            "tbody"
          ]
        }
      ],
      "id": "v2-semantic-network-numeric",
      "requiredSelectors": [
        "[data-whm-server-observation-refresh]",
        "[data-whm-server-observation-status]",
        "tbody[data-whm-server-observation-interface-rows]",
        "tbody[data-whm-server-observation-pool-rows]",
        "tbody[data-whm-server-observation-unpooled-rows]",
        "tbody[data-whm-server-observation-route-rows]"
      ],
      "applicableRoutes": [
        "/whm/server/networking"
      ]
    },
    "evidence": "whm-server-observation-client.ts:103-130,158-185; V2 server/observations.ts:23-31"
  },
  {
    "route": "/whm/server/terminal",
    "legacyHook": "[data-tone]",
    "requirement": {
      "rootAttributes": {
        "data-terminal-can-use": {
          "oneOf": [
            "true",
            "false"
          ]
        }
      },
      "applicableRoutes": [
        "/whm/server/terminal"
      ],
      "elements": [
        {
          "selector": "[data-terminal-pill],[data-terminal-exec-pill]",
          "occurrence": "every",
          "tags": [
            "span"
          ]
        },
        {
          "selector": "[data-terminal-status]",
          "attributes": {
            "data-state": {
              "oneOf": [
                "closed",
                "unavailable",
                "connecting",
                "open",
                "ended",
                "busy",
                "opening",
                "empty",
                "code",
                "locked",
                "wrong",
                "failed"
              ]
            },
            "role": {
              "oneOf": [
                "status",
                "alert"
              ]
            }
          },
          "tags": [
            "p"
          ]
        },
        {
          "selector": "[data-terminal-pill][data-tone]",
          "attributes": {
            "data-tone": {
              "oneOf": [
                "ok",
                "info"
              ]
            }
          },
          "required": false,
          "tags": [
            "span"
          ]
        },
        {
          "selector": "[data-terminal-exec-pill][data-tone]",
          "attributes": {
            "data-tone": {
              "oneOf": [
                "ok",
                "warn"
              ]
            }
          },
          "required": false,
          "tags": [
            "span"
          ]
        }
      ],
      "rootRequired": true,
      "conditionalRequirements": [
        {
          "elements": [
            {
              "selector": "[data-terminal-status]",
              "attributes": {
                "data-state": "unavailable",
                "role": "status"
              },
              "tags": [
                "p"
              ]
            }
          ],
          "rootAttributes": {
            "data-terminal-can-use": "false"
          }
        }
      ],
      "requiredSelectors": [
        "[data-terminal-pill]",
        "[data-terminal-exec-pill]",
        "[data-terminal-status]"
      ],
      "id": "v2-semantic-terminal-state",
      "rootSelector": "[data-terminal-workspace][data-terminal-kind=\"root\"]"
    },
    "evidence": "ops-terminal-client.ts:49-89,178-195; V2 server/terminal.ts:6-14,27-28; server/styles.ts:12-14"
  },
  {
    "route": "/whm/panel/data",
    "legacyHook": "[data-xp-slot]",
    "requirement": {
      "rootAttributes": {
        "data-generations-editable": {
          "oneOf": [
            "true",
            "false"
          ]
        }
      },
      "templateScopes": [
        {
          "templateSelector": "template[data-xp-template=\"whm-generation-current-active\"]",
          "required": true,
          "requiredSelectors": [
            "span[data-xp-slot=\"content\"][data-generations-current-label]"
          ]
        },
        {
          "templateSelector": "template[data-xp-template=\"whm-generation-current-none\"]",
          "required": true,
          "requiredSelectors": [
            "span[data-xp-slot=\"content\"][data-generations-current-label]"
          ]
        },
        {
          "templateSelector": "template[data-xp-template=\"whm-generation-row\"]",
          "required": true,
          "requiredSelectors": [
            "td[data-xp-slot=\"generation\"]",
            "td[data-xp-slot=\"created\"]",
            "td[data-xp-slot=\"summary\"]",
            "td[data-xp-slot=\"state\"]",
            "td[data-xp-slot=\"actions\"]"
          ]
        },
        {
          "templateSelector": "template[data-xp-template=\"whm-generation-empty\"]",
          "required": true,
          "requiredSelectors": [
            "td[data-xp-slot=\"content\"][colspan=\"5\"]"
          ]
        },
        {
          "templateSelector": "template[data-xp-template=\"whm-generation-state-active\"]",
          "required": true,
          "requiredSelectors": [
            "span[data-xp-slot=\"content\"]"
          ]
        },
        {
          "templateSelector": "template[data-xp-template=\"whm-generation-state-other\"]",
          "required": true,
          "requiredSelectors": [
            "span[data-xp-slot=\"content\"]"
          ]
        },
        {
          "templateSelector": "template[data-xp-template=\"whm-generation-rollback\"]",
          "required": true,
          "requiredSelectors": [
            "button[data-xp-slot=\"content\"][type=\"button\"][disabled]"
          ]
        }
      ],
      "applicableRoutes": [
        "/whm/panel/data"
      ],
      "elements": [
        {
          "selector": "[data-generation-rows]",
          "tags": [
            "tbody"
          ]
        },
        {
          "selector": "[data-generations-status]",
          "attributes": {
            "role": {
              "oneOf": [
                "status",
                "alert"
              ]
            }
          },
          "tags": [
            "p"
          ]
        }
      ],
      "rootRequired": true,
      "requiredSelectors": [
        "[data-generations-current]",
        "tbody[data-generation-rows]",
        "[data-generations-status]"
      ],
      "id": "v2-semantic-panel-generation-templates",
      "rootSelector": "[data-whm-generations]"
    },
    "evidence": "whm-panel-data-client.ts:16-44,61-88; V2 whm-client-templates.ts:7; panel/data.ts:8-23"
  }
]
interface NumericTable { readonly route: string; readonly rootHook: HookSelector; readonly rowsHook: HookSelector; readonly columns: number; readonly numericZeroBased: readonly number[] }
const numericTables: readonly NumericTable[] = [
  {
    "route": "/whm/accounts/bandwidth",
    "rootHook": "[data-whm-metering=\"bandwidth\"]",
    "rowsHook": "[data-whm-metering-rows=\"bandwidth\"]",
    "columns": 8,
    "numericZeroBased": [
      3,
      4,
      5,
      6,
      7
    ]
  },
  {
    "route": "/whm/server/networking",
    "rootHook": "[data-whm-server-observation=\"network\"]",
    "rowsHook": "[data-whm-server-observation-interface-rows]",
    "columns": 4,
    "numericZeroBased": [
      2
    ]
  },
  {
    "route": "/whm/server/networking",
    "rootHook": "[data-whm-server-observation=\"network\"]",
    "rowsHook": "[data-whm-server-observation-pool-rows]",
    "columns": 5,
    "numericZeroBased": []
  },
  {
    "route": "/whm/server/networking",
    "rootHook": "[data-whm-server-observation=\"network\"]",
    "rowsHook": "[data-whm-server-observation-unpooled-rows]",
    "columns": 3,
    "numericZeroBased": [
      2
    ]
  },
  {
    "route": "/whm/server/networking",
    "rootHook": "[data-whm-server-observation=\"network\"]",
    "rowsHook": "[data-whm-server-observation-route-rows]",
    "columns": 6,
    "numericZeroBased": [
      5
    ]
  }
]
interface GenerationTemplate { readonly name: string; readonly tag: string; readonly slots: Readonly<Record<string,string>>; readonly contentAttributes?: Readonly<Record<string,string|boolean>> }
const generationTemplates: readonly GenerationTemplate[] = [
  {
    "name": "whm-generation-current-active",
    "tag": "span",
    "slots": {
      "content": "span"
    }
  },
  {
    "name": "whm-generation-current-none",
    "tag": "span",
    "slots": {
      "content": "span"
    }
  },
  {
    "name": "whm-generation-row",
    "tag": "tr",
    "slots": {
      "generation": "td",
      "created": "td",
      "summary": "td",
      "state": "td",
      "actions": "td"
    }
  },
  {
    "name": "whm-generation-empty",
    "tag": "tr",
    "slots": {
      "content": "td"
    },
    "contentAttributes": {
      "colspan": "5"
    }
  },
  {
    "name": "whm-generation-state-active",
    "tag": "span",
    "slots": {
      "content": "span"
    }
  },
  {
    "name": "whm-generation-state-other",
    "tag": "span",
    "slots": {
      "content": "span"
    }
  },
  {
    "name": "whm-generation-rollback",
    "tag": "button",
    "slots": {
      "content": "button"
    },
    "contentAttributes": {
      "type": "button",
      "disabled": true
    }
  }
]

const backupRoutes = ['/whm/backups','/whm/backups/restore']
const backupParent = '[data-approved-whm-backups][data-backup-destination-editor="manager"]'
const backupManagerRequirement: ControllerDeclaration = {
  id: 'v2-semantic-backup-manager', rootSelector: 'section[data-whm-backup-destinations][data-backup-inline-manager][data-destination-sftp-projection]', rootRequired: true,
  applicableRoutes: backupRoutes, parentRootSelector: backupParent, rootAttributes: { 'data-can-manage': { oneOf: ['true','false'] } },
  requiredSelectors: ['[data-destination-form]','[data-destination-status]','tbody[data-destination-rows]','button[data-destination-read]','button[data-destination-new]','button[data-destination-save]','button[data-destination-create-key]','[data-destination-sftp-address]','input[data-destination-sftp-host]','input[data-destination-sftp-port]'],
  elements: [
    { selector: '[data-destination-status]', tags: ['p'], attributes: { role: { oneOf: ['status','alert'] } } },
    ...['read','new','create-key'].map(action=>({selector:'[data-destination-' + action + ']',tags:['button'],attributes:{type:'button',disabled:true}})),
    {selector:'[data-destination-save]',tags:['button'],attributes:{type:'submit',disabled:true}},
    {selector:'[data-destination-field="credentialRef"]',tags:['select'],attributes:{disabled:true}},
    {selector:'[data-destination-sftp-host]',tags:['input'],attributes:{type:'text',dir:'ltr',required:true,disabled:true,readonly:false}},
    {selector:'[data-destination-sftp-port]',tags:['input'],attributes:{type:'number',dir:'ltr',min:'1',max:'65535',step:'1',required:true,disabled:true,readonly:false}},
  ],
  templateScopes: [
    { templateSelector:'template[data-xp-template="backup-destination-row"]',required:true,requiredSelectors:['td[data-xp-slot="name"]','bdi[data-xp-slot="kind"][dir="ltr"]','bdi[data-xp-slot="endpoint"][dir="ltr"]','bdi[data-xp-slot="prefix"][dir="ltr"]','td[data-xp-slot="state"]',...['edit','test','activate','revoke','delete'].map(action=>'button[type="button"][data-xp-action="' + action + '"][disabled] > span[data-xp-slot="' + action + '-label"]')] },
    { templateSelector:'template[data-xp-template="backup-destination-empty"]',required:true,requiredSelectors:['tr > td[data-xp-slot="message"][colspan="5"]'] },
  ],
}
const backupCounterparts: readonly ObservationCounterpart[] = backupRoutes.flatMap(route => [
  ...(['[data-backup-destination-rows]','[data-backup-sftp-status]'] as const).map(legacyHook=>({route,legacyHook,requirement:backupManagerRequirement,evidence:'Positively delegated editor uses real independent destination manager rows/status and typed Test/Activate actions, retaining legacy schedule/run/restore ownership.'})),
])

/** Only destination arms are conditional in the V2 copy. Non-manager roots retain the original checks,
 * while manager mode has a positively mandatory real editor; all schedule/run/restore arms stay unconditional. */
const backupLegacyDestinationArms: Readonly<Record<string,readonly string[]>> = {
  "whm-backups-dynamic-104": [
    "#backup-layout-destination-enabled",
    "#backup-layout-destination-name",
    "#backup-layout-destination-retention",
    "#backup-layout-destination-endpoint",
    "#backup-layout-destination-prefix",
    "#backup-layout-destination-bucket",
    "#backup-layout-destination-region",
    "#backup-layout-destination-user"
  ],
  "whm-backups-dynamic-105": [
    "#backup-layout-destination-kind"
  ],
  "whm-backups-dynamic-106": [
    "[data-backup-action=\"save-destination\"]",
    "[data-backup-action=\"new-destination\"]"
  ],
  "whm-backups-dynamic-371": [
    "[data-backup-action=\"test-sftp\"]"
  ]
}
function v2BackupDeclaration(original: ControllerDeclaration): ControllerDeclaration {

  if(original.id==='whm-backups-forwarded') {
    const sftp='[data-backup-sftp-status]',arms=original.conditionalRequired
    if(original.rootSelector!=='[data-approved-whm-backups]' || !arms || arms.filter(arm=>arm.requiredSelectors?.includes(sftp)).length!==1) throw new Error('v2_backup_forwarded_mapping_stale')
    return {...original,conditionalRequired:arms.flatMap(arm=>{
      const selectors=arm.requiredSelectors
      if(!selectors?.includes(sftp)) return [arm]
      if(arm.elements?.some(element=>element.selector===sftp)) throw new Error('v2_backup_forwarded_element_mapping_stale')
      return [
        {...arm,requiredSelectors:selectors.filter(selector=>selector!==sftp)},
        {...arm,rootAttributes:{...arm.rootAttributes,'data-backup-destination-editor':{not:'manager'}},requiredSelectors:[sftp]},
      ]
    })}
  }
  const removed = backupLegacyDestinationArms[original.id]
  if (!removed) return original
  for (const selector of removed) if (!original.requiredSelectors?.includes(selector) || !original.elements?.some(element=>element.selector===selector)) throw new Error('v2_backup_legacy_mapping_stale:' + original.id + ':' + selector)
  return { ...original,
    requiredSelectors: original.requiredSelectors?.filter(selector=>!removed.includes(selector)),
    elements: original.elements?.filter(element=>!removed.includes(element.selector)),
    conditionalRequirements: [ ...(original.conditionalRequirements ?? []), {
      rootAttributes: { 'data-backup-destination-editor': { not: 'manager' } },
      requiredSelectors: original.requiredSelectors?.filter(selector=>removed.includes(selector)),
      elements: original.elements?.filter(element=>removed.includes(element.selector)),
    } ],
  }
}

const phpSwitchRequirement: ControllerDeclaration = { id: 'v2-semantic-php-extension-switch', rootSelector: 'document', rootRequired: true, applicableRoutes: ['/whm/software/php'],
  templateScopes: [{ templateSelector: 'template[data-xp-template="whm-php-extension-switch"]', required: true, requiredSelectors: ['input[type="checkbox"][data-xp-slot="input"]', '[data-xp-slot="state"]'] }] }

/** Controller templates V2 provides in another finite form the same controller accepts. Every other template the
 *  classic document records stays required, so a V2 page that omits a template its controller clones fails. */
export const V2_TEMPLATE_COUNTERPARTS: readonly { readonly routes: readonly string[]; readonly templates?: readonly string[]; readonly slots?: Readonly<Record<string, readonly string[]>>; readonly evidence: string; readonly requirement?: ControllerDeclaration }[] = [
  { routes: ['/domains/redirects'], templates: ['web-directive-action', 'web-directive-empty', 'web-directive-error', 'web-directive-row', 'web-directive-summary', 'web-directive-technical-cell', 'web-directive-text-cell'],
    evidence: 'account-web-directives-client.ts:170-174 takes the redirect-* family for the redirects feature and then needs only the notice and issue templates',
    requirement: { id: 'v2-semantic-redirect-templates', rootSelector: 'document', rootRequired: true, applicableRoutes: ['/domains/redirects'], templateScopes: [
      { templateSelector: 'template[data-xp-template="redirect-row"]', required: true, requiredSelectors: ['tr', '[data-xp-slot="status"]', '[data-xp-slot="path"]', '[data-xp-slot="target"]', '[data-xp-slot="actions"]'] },
      { templateSelector: 'template[data-xp-template="redirect-action"]', required: true, requiredSelectors: ['button[data-xp-slot="label"]'] },
      { templateSelector: 'template[data-xp-template="redirect-empty"]', required: true, requiredSelectors: ['tr', '[data-xp-slot="message"]'] },
      { templateSelector: 'template[data-xp-template="redirect-error"]', required: true, requiredSelectors: ['tr', '[data-xp-slot="message"]'] },
    ] } },
  { routes: ['/whm/transfers', '/whm/transfers/server'], slots: { 'transfer-inventory-row': ['selected'] },
    evidence: 'whm-transfer-client.ts:63,77 reads the comparison layout: a uid slot and the select action replace the selected slot',
    requirement: { id: 'v2-semantic-transfer-inventory-row', rootSelector: 'document', rootRequired: true, applicableRoutes: ['/whm/transfers', '/whm/transfers/server'], templateScopes: [
      { templateSelector: 'template[data-xp-template="transfer-inventory-row"]', required: true, requiredSelectors: ['tr', '[data-xp-slot="uid"]', 'input[type="checkbox"][data-xp-action="select"]'] },
    ] } },
]

let cachedV2RouteContracts: ReturnType<typeof routeContracts> | undefined

/** A V2 profile is selected deliberately by conformance tooling. The default Classic API is untouched.
 * Only the explicitly sourced observations below are substituted; all original independent controllers/templates, real announcements, backup and transfer requirements stay active. */
export function v2RouteContracts(): ReturnType<typeof routeContracts> {
  if (cachedV2RouteContracts) return cachedV2RouteContracts.slice()
  cachedV2RouteContracts = routeContracts().map(base => {
    const counterparts = [...V2_OBSERVATION_COUNTERPARTS, ...extraObservations, ...V2_STATEFUL_OBSERVATION_COUNTERPARTS, ...backupCounterparts].filter(item => item.route === base.route)
    const removed: readonly HookSelector[] = ['[data-status]', ...counterparts.map(item => item.legacyHook), ...(base.route === '/home' ? V2_HOME_OBSERVATION_HOOKS : [])]
    const hooks = base.hooks.filter(hook => !removed.includes(hook))
    // Core status-page admission is document-root-only; the Classic badge updater is class-scoped.
    // V2 exposes the real same-core live-state machine rather than a cosmetic xp-badge data-status.
    for (const counterpart of counterparts) {
      // A retired classic placeholder leaves its V2 requirement in force.
      if (counterpart.legacyHook !== '[data-wiring="soon"]' && !base.hooks.includes(counterpart.legacyHook)) throw new Error('v2_observation_mapping_stale:' + base.route + ':' + counterpart.legacyHook)
    }
    const templateCounterparts = V2_TEMPLATE_COUNTERPARTS.filter(item => item.routes.includes(base.route))
    const templates = (base.templates ?? []).filter(template => !templateCounterparts.some(item => item.templates?.includes(template.name)))
      .map(template => ({ ...template, slots: template.slots.filter(slot => !templateCounterparts.some(item => item.slots?.[template.name]?.includes(slot))) }))
    // A counterpart whose classic template or slot is gone would silently excuse nothing: it must be removed.
    for (const item of templateCounterparts) {
      for (const name of item.templates ?? []) if (!base.templates?.some(template => template.name === name)) throw new Error('v2_template_mapping_stale:' + base.route + ':' + name)
      for (const [name, slots] of Object.entries(item.slots ?? {})) for (const slot of slots) if (!base.templates?.find(template => template.name === name)?.slots.includes(slot)) throw new Error('v2_template_mapping_stale:' + base.route + ':' + name + ':' + slot)
    }
    return { ...base, hooks, ...(base.templates ? { templates } : {}), authoritativeControllers: [
      ...(backupRoutes.includes(base.route) ? (base.authoritativeControllers ?? []).map(v2BackupDeclaration) : (base.authoritativeControllers ?? [])), ...V2_SHARED_CHROME_REQUIREMENTS,
      { id: 'v2-semantic-document-surface', rootSelector: 'html', rootRequired: true, rootAttributes: { 'data-surface': base.surface } },
      ...counterparts.map(item => item.requirement),
      ...(base.route === '/home' ? [homeRequirement] : []),
      ...(base.route === '/metrics/web-stats' ? [V2_WEB_STATS_REQUIREMENT] : []),
      ...(backupRoutes.includes(base.route) ? [{ id:'v2-semantic-backup-manager-mode',rootSelector:backupParent,rootRequired:true,applicableRoutes:backupRoutes,rootAttributes:{'data-backup-manage':{oneOf:['true','false']}} }] : []),
      ...(base.route === '/whm/software/php' ? [phpSwitchRequirement] : []),
      ...templateCounterparts.flatMap(item => item.requirement ? [item.requirement] : []),
    ] }
  })
  return cachedV2RouteContracts.slice()
}

const sameOutlineNode = (a: MarkupNode, b: MarkupNode): boolean => a.tag === b.tag && a.namespace === b.namespace && a.parent === b.parent && a.template === b.template && a.attrs.size === b.attrs.size && [...a.attrs].every(([key, value]) => b.attrs.get(key) === value)
/** Bind a plain, theme-owned label to its existing parser node; this is not an HTML parser or sanitizer. */
function ownedLabelText(html: string, nodes: readonly MarkupNode[], index: number, state: string): string | undefined {
  const target = nodes[index]
  if (!target || nodes.some(node => node.parent === index)) return undefined
  const span = markupNodeSpan(target)
  if (span !== undefined) {
    if (html.indexOf('>', span.start) !== span.openEnd - 1) return undefined
    const openSlice = html.slice(span.start, span.openEnd)
    if (!openSlice.includes('data-ws-label="' + state + '"') && !openSlice.includes("data-ws-label='" + state + "'")) return undefined
    const close = /<\/span\s*>/gi
    close.lastIndex = span.openEnd
    const found = close.exec(html)
    return found ? html.slice(span.openEnd, found.index) : undefined
  }
  for (const quote of ['"', "'"]) {
    const marker = 'data-ws-label=' + quote + state + quote
    let cursor = 0
    while (cursor < html.length) {
      const at = html.indexOf(marker, cursor)
      if (at < 0) break
      cursor = at + marker.length
      const start = html.lastIndexOf('<', at), end = html.indexOf('>', at)
      if (start < 0 || end < 0 || parseMarkup(html.slice(0, start)).length !== index) continue
      const prefix = parseMarkup(html.slice(0, end + 1))
      const actual = prefix[index]
      if (prefix.length !== index + 1 || !actual || !sameOutlineNode(actual, target)) continue
      const close = /<\/span\s*>/gi
      close.lastIndex = end + 1
      const found = close.exec(html)
      return found ? html.slice(end + 1, found.index) : undefined
    }
  }
  return undefined
}
function ownedPlainText(html: string,nodes: readonly MarkupNode[],index: number): string | undefined {
  const target=nodes[index]
  if(!target || !isHtmlElement(target) || nodes.some(node=>node.parent===index)) return undefined
  const span = markupNodeSpan(target)
  if (span !== undefined) {
    if (html.indexOf('>', span.start) !== span.openEnd - 1) return undefined
    if (html.slice(span.start, span.start + 1 + target.tag.length).toLowerCase() !== '<' + target.tag) return undefined
    const close = new RegExp('</' + target.tag + '\\s*>', 'gi')
    close.lastIndex = span.openEnd
    const match = close.exec(html)
    return match ? html.slice(span.openEnd, match.index) : undefined
  }
  let cursor=0
  while(cursor<html.length) {
    const start=html.indexOf('<' + target.tag,cursor)
    if(start<0) return undefined
    const end=html.indexOf('>',start)
    if(end<0) return undefined
    cursor=end+1
    if(parseMarkup(html.slice(0,start)).length!==index) continue
    const prefix=parseMarkup(html.slice(0,end+1)),actual=prefix[index]
    if(prefix.length!==index+1 || !actual || !sameOutlineNode(actual,target)) continue
    const close=new RegExp('</' + target.tag + '\\s*>','gi');close.lastIndex=end+1
    const match=close.exec(html)
    return match ? html.slice(end+1,match.index) : undefined
  }
  return undefined
}

const asciiCount = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : undefined
}
/** Preserve the core checker, then validate actual V2 visibility/text and optional known count semantics. */
export function checkV2Conformance(html: string, requirement: HookRequirement, parsedNodes?: readonly MarkupNode[]): ReturnType<typeof checkConformance> {
  const nodes = parsedNodes ?? parseMarkup(html), issues = checkConformance(html, requirement, nodes)
  const add = (name: string, controller: string): void => { if (!issues.some(issue => issue.kind === 'element' && issue.name === name && issue.controller === controller)) issues.push({ kind: 'element', name, controller }) }
  const blocked = (index: number): boolean => {
    for (let at = index; at >= 0;) {
      const node = nodes[at]
      if (!node || !isHtmlElement(node) || node.template >= 0 || node.attrs.has('hidden') || node.attrs.has('inert') || node.attrs.get('aria-hidden')?.toLowerCase() === 'true') return true
      at = node.parent
    }
    return false
  }
  const controls = nodes.flatMap((node, index) => node.template < 0 && node.attrs.has('data-ws-indicator') ? [index] : [])
  if (controls.length !== 1) add('[data-ws-indicator]', 'v2-visible-live-status')
  else {
    const controlIndex = controls[0]
    if (controlIndex === undefined || blocked(controlIndex)) add('[data-ws-indicator]', 'v2-visible-live-status')
    const locale = nodes.find(node => isHtmlElement(node, 'html'))?.attrs.get('lang')
    if (!isLocale(locale)) add('[data-ws-label]', 'v2-visible-live-label')
    else {
      const t = translator(locale)
      const expected = { connected: t(msgctxt('ws-client', 'Live')), disconnected: t('Connecting'), unavailable: t('Live updates off') }
      for (const [state, label] of Object.entries(expected)) {
        const selected = nodes.flatMap((node, index) => node.template < 0 && node.parent === controlIndex && node.attrs.get('data-ws-label') === state ? [index] : [])
        const index = selected[0]
        if (selected.length !== 1 || index === undefined || blocked(index) || label.trim() === '' || ownedLabelText(html, nodes, index, state) !== escapeHtml(label)) add('[data-ws-label="' + state + '"]', 'v2-visible-live-label')
      }
    }
  }
  const route = requirement.context?.route ?? ''
  const within = (index: number, owner: number): boolean => {
    for (let at = index; at >= 0;) {
      if (at === owner) return true
      const node = nodes[at]
      if (!node) return false
      at = node.parent
    }
    return false
  }
  const live = (hook: HookSelector, owner?: number): number[] => nodes.flatMap((node,index) => node.template < 0 && isHtmlElement(node) && matchesHook(node,hook) && (owner === undefined || within(index,owner)) ? [index] : [])
  for (const table of numericTables.filter(table => table.route === route)) {
    const roots = live(table.rootHook), root = roots[0]
    const bodies = root === undefined ? [] : live(table.rowsHook,root), body = bodies[0], bodyNode = body === undefined ? undefined : nodes[body]
    if (roots.length !== 1 || root === undefined || blocked(root) || bodies.length !== 1 || body === undefined || (!bodyNode || !isHtmlElement(bodyNode,'tbody')) || blocked(body)) {
      add(table.rowsHook,'v2-numeric-loaded-row'); continue
    }
    const rows = nodes.flatMap((node,index) => node.parent === body && node.template < 0 && isHtmlElement(node,'tr') ? [index] : [])
    for (const row of rows) {
      const cells = nodes.flatMap((node,index) => node.parent === row && node.template < 0 && isHtmlElement(node,'td') ? [index] : [])
      const first = cells[0], firstCell = first === undefined ? undefined : nodes[first]
      if (cells.length === 1 && firstCell?.attrs.get('colspan') === String(table.columns)) continue
      if (cells.length !== table.columns || blocked(row) || cells.some(index => nodes[index]?.attrs.has('colspan'))) { add(table.rowsHook,'v2-numeric-loaded-row'); continue }
      for (const column of table.numericZeroBased) {
        const index = cells[column], cell = index === undefined ? undefined : nodes[index]
        const isolation = index === undefined ? [] : nodes.flatMap((node,at) => node.template < 0 && isHtmlElement(node,'bdi') && node.attrs.get('dir') === 'ltr' && within(at,index) && !blocked(at) ? [at] : [])
        if (index === undefined || !cell?.attrs.has('data-numeric') || blocked(index) || isolation.length !== 1) add(table.rowsHook + ':numeric-column-' + column,'v2-numeric-loaded-row')
      }
    }
  }
  if (route === '/whm/server/terminal') {
    const roots = live('[data-terminal-workspace]'), root = roots[0]
    const owner = root === undefined ? undefined : nodes[root]
    if (roots.length !== 1 || root === undefined || !owner || blocked(root) || owner.attrs.get('data-terminal-kind') !== 'root' || !['true','false'].includes(owner.attrs.get('data-terminal-can-use') ?? '')) add('[data-terminal-workspace]','v2-terminal-state-ownership')
    else {
      for (const hook of ['[data-terminal-pill]','[data-terminal-exec-pill]','[data-terminal-status]'] as const) {
        const selected = live(hook,root), at = selected[0], node = at === undefined ? undefined : nodes[at]
        if (selected.length !== 1 || at === undefined || !node || blocked(at) || !isHtmlElement(node,hook === '[data-terminal-status]' ? 'p' : 'span')) { add(hook,'v2-terminal-state-ownership'); continue }
        if (hook === '[data-terminal-status]' && (owner.attrs.get('data-terminal-can-use') === 'false' && node.attrs.get('data-state') !== 'unavailable' || !['status','alert'].includes(node.attrs.get('role') ?? ''))) add(hook,'v2-terminal-state-ownership')
      }
    }
  }
  if (route === '/whm/panel/data') {
    const roots = live('[data-whm-generations]'), root = roots[0]
    if (roots.length !== 1 || root === undefined || blocked(root)) add('[data-whm-generations]','v2-generation-template-ownership')
    else for (const spec of generationTemplates) {
      const selected = nodes.flatMap((node,index) => node.template < 0 && node.attrs.get('data-xp-template') === spec.name && within(index,root) ? [index] : [])
      const at = selected[0], template = at === undefined ? undefined : nodes[at]
      if (selected.length !== 1 || at === undefined || !template || !isHtmlElement(template,'template')) { add(spec.name,'v2-generation-template-ownership'); continue }
      const tops = nodes.flatMap((node,index) => node.parent === at && node.template === at ? [index] : [])
      const top = tops[0], topNode = top === undefined ? undefined : nodes[top]
      if (tops.length !== 1 || top === undefined || !topNode || !isHtmlElement(topNode,spec.tag)) { add(spec.name,'v2-generation-template-ownership'); continue }
      const slotNodes = nodes.flatMap((node,index) => node.template === at && node.attrs.has('data-xp-slot') ? [index] : [])
      if (slotNodes.length !== Object.keys(spec.slots).length) add(spec.name,'v2-generation-template-ownership')
      for (const [slot,tag] of Object.entries(spec.slots)) {
        const slots = slotNodes.filter(index => nodes[index]?.attrs.get('data-xp-slot') === slot), index = slots[0], node = index === undefined ? undefined : nodes[index]
        if (slots.length !== 1 || index === undefined || !node || !within(index,top) || !isHtmlElement(node,tag)) { add(spec.name + ':' + slot,'v2-generation-template-ownership'); continue }
        if (slot === 'content') for (const [attribute,value] of Object.entries(spec.contentAttributes ?? {})) if (typeof value === 'boolean' ? node.attrs.has(attribute) !== value : node.attrs.get(attribute) !== value) add(spec.name + ':' + slot,'v2-generation-template-ownership')
      }
    }
  }

  if (backupRoutes.includes(route)) {
    const parents=live('[data-approved-whm-backups]'),parent=parents[0],owner=parent===undefined?undefined:nodes[parent]
    const fail=(name:string)=>add(name,'v2-backup-manager-ownership')
    if(parents.length!==1 || parent===undefined || !owner || owner.attrs.get('data-backup-destination-editor')!=='manager') fail('[data-backup-destination-editor="manager"]')
    else {
      const managers=live('[data-whm-backup-destinations]'),manager=managers[0],managerNode=manager===undefined?undefined:nodes[manager]
      if(managers.length!==1 || manager===undefined || !managerNode || !isHtmlElement(managerNode,'section') || !within(manager,parent) || !managerNode.attrs.has('data-backup-inline-manager') || !managerNode.attrs.has('data-destination-sftp-projection') || !['true','false'].includes(owner.attrs.get('data-backup-manage')??'') || managerNode.attrs.get('data-can-manage')!==owner.attrs.get('data-backup-manage')) fail('[data-whm-backup-destinations]')
      else {
        const forms=live('[data-destination-form]',manager),form=forms[0],formNode=form===undefined?undefined:nodes[form]
        const manage=managerNode.attrs.get('data-can-manage')==='true'
        if(forms.length!==1 || form===undefined || !formNode || !isHtmlElement(formNode,manage?'form':'div') || nodes.some((node,index)=>node.template<0 && isHtmlElement(node,'form') && within(index,manager) && index!==form)) fail('[data-destination-form]')
        else {
          const expectedFields: Readonly<Record<string,{tag:string;type?:string;dir?:string}>>={name:{tag:'input',type:'text',dir:'auto'},kind:{tag:'select'},endpoint:{tag:'input',type:'text',dir:'ltr'},bucket:{tag:'input',type:'text',dir:'ltr'},region:{tag:'input',type:'text',dir:'ltr'},pathPrefix:{tag:'input',type:'text',dir:'ltr'},username:{tag:'input',type:'text',dir:'ltr'},retentionDays:{tag:'input',type:'number',dir:'ltr'},credentialRef:{tag:'select'}}
          const fields=live('[data-destination-field]',manager)
          if(fields.length!==Object.keys(expectedFields).length) fail('[data-destination-field]')
          for(const [name,expected] of Object.entries(expectedFields)) {
            const selected=fields.filter(index=>nodes[index]?.attrs.get('data-destination-field')===name),index=selected[0],field=index===undefined?undefined:nodes[index]
            if(selected.length!==1 || index===undefined || !field || !within(index,form) || !isHtmlElement(field,expected.tag) || expected.type!==undefined && field.attrs.get('type')!==expected.type || expected.dir!==undefined && field.attrs.get('dir')!==expected.dir || !field.attrs.has('disabled') || name==='endpoint' && field.attrs.has('readonly') || name==='retentionDays' && (field.attrs.get('min')!=='1' || field.attrs.get('max')!=='3650' || field.attrs.get('step')!=='1')) fail('[data-destination-field="' + name + '"]')
          }
          const groups=live('[data-destination-sftp-address]',form),group=groups[0]
          if(groups.length!==1 || group===undefined) fail('[data-destination-sftp-address]')
          else for(const hook of ['[data-destination-sftp-host]','[data-destination-sftp-port]'] as const) {
            const selected=live(hook,manager),index=selected[0],field=index===undefined?undefined:nodes[index],id=field?.attrs.get('id')
            if(selected.length!==1 || index===undefined || !field || !within(index,group) || !isHtmlElement(field,'input') || !id || nodes.filter(node=>node.template<0 && node.attrs.get('id')===id).length!==1 || nodes.filter((node,index)=>node.template<0 && isHtmlElement(node,'label') && within(index,group) && node.attrs.get('for')===id).length!==1) fail(hook)
          }
        }
        for(const name of ['backup-destination-row','backup-destination-empty']) {
          const templates=nodes.flatMap((node,index)=>node.template<0 && node.attrs.get('data-xp-template')===name && within(index,manager)?[index]:[]),template=templates[0],templateNode=template===undefined?undefined:nodes[template]
          if(templates.length!==1 || template===undefined || !templateNode || !isHtmlElement(templateNode,'template')) {fail(name);continue}
          const tops=nodes.flatMap((node,index)=>node.parent===template && node.template===template?[index]:[]),top=tops[0],topNode=top===undefined?undefined:nodes[top]
          if(tops.length!==1 || top===undefined || !topNode || !isHtmlElement(topNode,'tr')) {fail(name);continue}
          const slots: Readonly<Record<string,string>>=name==='backup-destination-row'?{name:'td',kind:'bdi',endpoint:'bdi',prefix:'bdi',state:'td','edit-label':'span','test-label':'span','activate-label':'span','revoke-label':'span','delete-label':'span'}:{message:'td'}
          const slotNodes=nodes.flatMap((node,index)=>node.template===template && node.attrs.has('data-xp-slot')?[index]:[])
          if(slotNodes.length!==Object.keys(slots).length) fail(name)
          for(const [slot,tag] of Object.entries(slots)) {
            const selected=slotNodes.filter(index=>nodes[index]?.attrs.get('data-xp-slot')===slot),index=selected[0],node=index===undefined?undefined:nodes[index]
            if(selected.length!==1 || index===undefined || !node || !within(index,top) || !isHtmlElement(node,tag) || tag==='bdi' && node.attrs.get('dir')!=='ltr' || slot==='message' && node.attrs.get('colspan')!=='5') fail(name+':'+slot)
          }
          if(name==='backup-destination-row') for(const action of ['edit','test','activate','revoke','delete']) {
            const selected=nodes.flatMap((node,index)=>node.template===template && node.attrs.get('data-xp-action')===action?[index]:[]),index=selected[0],button=index===undefined?undefined:nodes[index]
            if(selected.length!==1 || index===undefined || !button || !within(index,top) || !isHtmlElement(button,'button') || button.attrs.get('type')!=='button' || !button.attrs.has('disabled') || !slotNodes.some(at=>nodes[at]?.attrs.get('data-xp-slot')===action+'-label' && within(at,index))) fail(name+':'+action)
          }
        }
      }
      // The local archive list is mounted once, inside the backup owner, with its home-files-only scope warning.
      const archives=live('[data-account-backups]'),local=archives[0]
      if(archives.length!==1 || local===undefined || !isHtmlElement(nodes[local] ?? owner,'section') || !within(local,parent)) fail('[data-account-backups]')
      else {
        const locale=nodes.find(node=>isHtmlElement(node,'html'))?.attrs.get('lang')
        if(!isLocale(locale)) fail('[data-local-archive-scope-warning]')
        else {
          const t=translator(locale)
          const copies=[t('This local archive workflow copies home files and excludes the standard mail data and mail settings directories. It does not create database dumps or capture DNS zones. Review a component backup for those parts.'),t('The archive is stored in the local backup directory, limited to 2 GiB, and restored only into that account home.')]
          const paragraphs=nodes.flatMap((node,index)=>node.template<0 && isHtmlElement(node,'p') && within(index,local)?[index]:[])
          for(const copy of copies) if(!paragraphs.some(index=>ownedPlainText(html,nodes,index)===escapeHtml(copy))) fail('[data-account-backups]:copy')
          const warnings=live('[data-local-archive-scope-warning]',local),warning=warnings[0]
          if(warnings.length!==1 || warning===undefined || ownedPlainText(html,nodes,warning)!==escapeHtml(copies[0]??'')) fail('[data-local-archive-scope-warning]')
        }
      }
    }
  }

  if (['/mail/inbox', '/mail/sent', '/mail/drafts', '/mail/trash'].includes(route)) {
    const owners = live('[data-mail-folder-workspace]'), owner = owners[0]
    const pagers = owner === undefined ? [] : live('[data-mail-pager]',owner), index = pagers[0], pager = index === undefined ? undefined : nodes[index]
    if (owners.length !== 1 || owner === undefined || blocked(owner) || pagers.length !== 1 || index === undefined || !pager || !isHtmlElement(pager,'span') || blocked(index) || !pager.attrs.has('data-rest') || asciiCount(pager.attrs.get('data-loaded')) === undefined) add('[data-loaded]', 'v2-mail-known-count')
    else if (pager.attrs.has('data-total')) {
      const total = asciiCount(pager.attrs.get('data-total')), loaded = asciiCount(pager.attrs.get('data-loaded'))
      if (total === undefined || loaded === undefined || total < loaded) add('[data-total]', 'v2-mail-known-count')
    }
  }
  return issues
}
