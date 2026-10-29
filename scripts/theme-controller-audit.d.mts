import type { ControllerDeclaration } from '../apps/web/src/themes/controller-conformance.ts'
import type { SelectorSourceReview, SelectorSiteReview } from '../apps/web/src/themes/selector-audit-data.ts'
export const SELECTOR_METHODS: readonly SelectorSiteReview['method'][]
export interface SelectorSite {
  line: number
  column: number
  method: SelectorSiteReview['method']
  argument: string
  offset: number
}
export function selectorSourceDigest(source: string): string
export function nonliteralSelectorSites(source: string): SelectorSite[]
export function assertSelectorReview(path: string, source: string, review?: SelectorSourceReview): SelectorSite[]
export function assertControllerReviewMappings(reviews: readonly SelectorSourceReview[], declarations?: readonly ControllerDeclaration[]): void
export function assertControllerSourceAudit(sourceRoot?: string, reviews?: readonly SelectorSourceReview[]): {
  files: number
  sites: number
  methodCounts: Record<SelectorSiteReview['method'], number>
  sourceNormalization: string
}
