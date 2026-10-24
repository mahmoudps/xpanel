import type { ComposeModel } from './xmail-compose.ts'
import type { InboxModel } from './xmail-inbox.ts'
import type { HomeDesktopModel, HomePhoneModel } from './xpanel-home.ts'
import type { AccountsBoardModel } from './xwhm-accounts.ts'
import type { WhmDashboardModel } from './xwhm-dashboard.ts'

/**
 * Board-sample models for the pixel gate. The test server calls
 * `installBoardGateFixture` around `renderWebApp`. These fields are not
 * product surface props.
 *
 * `apps/api/src/main.ts` never calls the installer. The slot also stays empty
 * unless Vitest is running, so a product process cannot show the sample.
 *
 * Stable field names: `homePort`, `dashboardPort`, `inboxPort`, `composePort`.
 * A new screen adds an optional field. Do not rename those four.
 */
export interface BoardGateFixture {
  homePort?: { desktop: HomeDesktopModel; phone: HomePhoneModel }
  dashboardPort?: WhmDashboardModel
  inboxPort?: InboxModel
  composePort?: ComposeModel
  accountsPort?: AccountsBoardModel
}

let current: BoardGateFixture | undefined

export const installBoardGateFixture = (fixture: BoardGateFixture | undefined): void => {
  if (process.env.VITEST !== 'true') return
  current = fixture
}

export const boardGateFixture = (): BoardGateFixture | undefined => current
