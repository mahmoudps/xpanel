// Settings family (TplSettings): sections of fields beside a current-vs-proposed review, ending in the apply bar
// (configuration generations: tests, next generation, rollback target) or a revision-checked save.

import type { Translate } from '../../../i18n.ts'
import type { HookAttributes } from '../html.ts'
import { card, type CardProps } from '../components/card.ts'
import { applyBar, changeReview, type ApplyBarProps, type ChangeReviewProps } from '../components/change-review.ts'
import { dialog, type DialogProps } from '../components/dialog.ts'
import { formField, switchRow, type FormFieldProps, type SwitchRowProps } from '../components/form-field.ts'
import { cards, commitRegion, layoutRoot, revisionSaveBar, splitWithAside, stateBlock, type LayoutState, type PageBaseProps, type RevisionSaveProps, type StateSlots } from './common.ts'

export type SettingsField = ({ kind: 'field' } & FormFieldProps) | ({ kind: 'switch' } & SwitchRowProps)

export interface SettingsSection {
  title: string
  titleId: string
  description?: string
  /** Fields sit in a responsive grid 16px apart; switches take a whole row. */
  fields?: readonly SettingsField[]
  /** Kit markup after the fields, such as a threshold scale. */
  bodyHtml?: string
  actionsHtml?: string
  hooks?: HookAttributes
}

/** Configuration settings apply as a tested generation; other settings save with a revision check. */
export type SettingsCommit =
  | { kind: 'apply'; review?: ChangeReviewProps; bar: ApplyBarProps }
  | { kind: 'revision'; review?: ChangeReviewProps; bar: RevisionSaveProps }

export interface SettingsPageProps extends PageBaseProps {
  /** Loading and error replace the form: nothing is editable before a read succeeds. */
  state?: Exclude<LayoutState, 'empty'>
  states?: StateSlots
  sections: readonly SettingsSection[]
  commit: SettingsCommit
  /** Cards under the review in the side column, such as the observed service effect. */
  aside?: readonly CardProps[]
  /** Names the side column, such as "Review and mail server state". */
  asideLabel?: string
  /** Full-width cards after the form, such as a per-mailbox state table. */
  extra?: readonly CardProps[]
  /** Discard or risky-apply confirmations (alertdialog). */
  dialogs?: readonly DialogProps[]
}

const field = (item: SettingsField): string => item.kind === 'switch' ? switchRow(item) : formField(item)

export const settingsSection = (section: SettingsSection): string => card({
  title: section.title, titleId: section.titleId, description: section.description, actionsHtml: section.actionsHtml, hooks: section.hooks,
  bodyHtml: `${section.fields?.length ? `<div class="v2-fields">${section.fields.map(field).join('')}</div>` : ''}${section.bodyHtml ?? ''}`,
})

export function settingsPage(t: Translate, props: SettingsPageProps): string {
  const state = props.state ?? 'ready'
  if (state !== 'ready') return layoutRoot(t, props, stateBlock(t, state, props.states))
  const { commit } = props
  const review = commit.review ? changeReview(t, commit.review) : ''
  const side = `${review}${cards(props.aside)}`
  const bar = commit.kind === 'apply'
    ? commitRegion(t(msgctxt('theme:v2', 'Apply changes')), applyBar(t, commit.bar))
    : commitRegion(t('Save changes'), revisionSaveBar(t, commit.bar))
  return layoutRoot(t, props, `${splitWithAside(props.sections.map(settingsSection).join(''), side ? { label: props.asideLabel ?? t('Review changes'), html: side } : undefined)}${cards(props.extra)}${bar}${(props.dialogs ?? []).map(item => dialog(t, item)).join('')}`)
}
