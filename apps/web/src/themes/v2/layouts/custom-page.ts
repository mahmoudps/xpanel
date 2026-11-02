// Custom family (TplCustom): a free grid of section cards with the page states, including a capability that is
// not installed on this server (the page stays readable; nothing claims success).

import type { Translate } from '../../../i18n.ts'
import { card, type CardProps } from '../components/card.ts'
import { notice, type NoticeProps } from '../components/notice.ts'
import { errorState } from '../components/state-block.ts'
import { layoutRoot, stateBlock, type LayoutState, type PageBaseProps, type StateSlots } from './common.ts'

export interface GridSection extends CardProps {
  /** Takes the whole row instead of sharing it (sections are at least 420px wide). */
  full?: boolean
}

export interface CustomPageProps extends PageBaseProps {
  state?: LayoutState | 'not-installed'
  states?: StateSlots & {
    /** Names the missing capability and who installs it, such as "ClamAV is not installed on this server." */
    notInstalled?: Pick<NoticeProps, 'lead' | 'text' | 'action' | 'hooks'>
  }
  sections: readonly GridSection[]
}

export const sectionGrid = (sections: readonly GridSection[]): string =>
  `<div class="v2-grid">${sections.map(section => `<div class="v2-grid__cell${section.full ? ' v2-grid__cell--full' : ''}">${card(section)}</div>`).join('')}</div>`

export function customPage(t: Translate, props: CustomPageProps): string {
  const state = props.state ?? 'ready'
  const states = props.states ?? {}
  // Loading and empty replace the sections; an error or a missing capability keeps the last read visible.
  if (state === 'loading' || state === 'empty') return layoutRoot(t, props, stateBlock(t, state, states))
  const lead = state === 'error' ? errorState(t, states.error ?? { lead: t(msgctxt('theme:v2', 'This page could not be read.')) })
    : state === 'not-installed' ? notice(t, { tone: 'warn', lead: t('Not installed'), text: '', ...states.notInstalled }) : ''
  return layoutRoot(t, props, sectionGrid(props.sections), lead)
}
