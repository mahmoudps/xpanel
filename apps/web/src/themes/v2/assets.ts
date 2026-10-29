// The v2 stylesheet: tokens, base, every component, the page layouts and the shell in one cached asset that core serves as
// /assets/themes/v2/styles.css?v=<version>. The version changes whenever the stylesheet does.

import { createHash } from 'node:crypto'
import type { ThemeAsset } from '../contract.ts'
import { V2_BASE_CSS } from './base.ts'
import { V2_TOKENS_CSS } from './tokens.ts'
import { BULK_BAR_CSS } from './components/bulk-bar.ts'
import { CARD_CSS } from './components/card.ts'
import { CHANGE_REVIEW_CSS } from './components/change-review.ts'
import { CHART_CSS } from './components/chart.ts'
import { CODE_BLOCK_CSS } from './components/code-block.ts'
import { DATA_TABLE_CSS } from './components/data-table.ts'
import { DIALOG_CSS } from './components/dialog.ts'
import { DRAWER_CSS } from './components/drawer.ts'
import { FILTER_BAR_CSS } from './components/filter-bar.ts'
import { FORM_FIELD_CSS } from './components/form-field.ts'
import { KPI_CARD_CSS } from './components/kpi-card.ts'
import { METER_CSS } from './components/meter.ts'
import { NOTICE_CSS } from './components/notice.ts'
import { PAGE_HEADER_CSS } from './components/page-header.ts'
import { PAGINATION_CSS } from './components/pagination.ts'
import { ROW_MENU_CSS } from './components/row-menu.ts'
import { STATE_BLOCK_CSS } from './components/state-block.ts'
import { STATUS_PILL_CSS } from './components/status-pill.ts'
import { STEPPER_CSS } from './components/stepper.ts'
import { TABS_CSS } from './components/tabs.ts'
import { TOAST_REGION_CSS } from './components/toast-region.ts'
import { LAYOUTS_CSS } from './layouts/index.ts'
import { OVERLAYS_CSS } from './shell/overlays.ts'
import { SHELL_CSS } from './shell/shell.ts'

// Order matters only where equal selectors meet: base before components, components before the page layouts,
// layouts before the shell.
const SOURCES = [
  V2_TOKENS_CSS, V2_BASE_CSS, STATUS_PILL_CSS, PAGE_HEADER_CSS, CARD_CSS, KPI_CARD_CSS, CHART_CSS, NOTICE_CSS,
  DATA_TABLE_CSS, FILTER_BAR_CSS, BULK_BAR_CSS, DRAWER_CSS, DIALOG_CSS, ROW_MENU_CSS, TABS_CSS, STEPPER_CSS,
  PAGINATION_CSS, CHANGE_REVIEW_CSS, FORM_FIELD_CSS, CODE_BLOCK_CSS, METER_CSS, STATE_BLOCK_CSS, TOAST_REGION_CSS,
  LAYOUTS_CSS, OVERLAYS_CSS, SHELL_CSS,
]

const css = SOURCES.map(source => source.trim()).join('\n') + '\n'
const version = createHash('sha256').update(css).digest('hex').slice(0, 16)

export const v2Stylesheet = Object.freeze({
  path: '/assets/themes/v2/styles.css',
  href: `/assets/themes/v2/styles.css?v=${version}`,
  contentType: 'text/css; charset=utf-8',
  version,
  body: css,
} satisfies ThemeAsset & { readonly version: string })

export const v2Assets: readonly ThemeAsset[] = Object.freeze([v2Stylesheet])

/** Latin text uses Plex Sans and Mono. The stylesheet keeps Arabic in generic sans-serif. */
export const v2FontsHref = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap'
