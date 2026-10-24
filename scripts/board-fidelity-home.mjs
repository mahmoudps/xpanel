import { renderLiveDocument } from '../apps/web/src/board-port/xpanel-home.fixture.ts'
import { isBoardRunnerMain, runBoardDiagnostics } from './board-evidence.mjs'

// A partial diagnostic only. Use board-fidelity.mjs for all mandatory products.
// Supply each external reference explicitly; no private folder layout is assumed.
export const boardScreens = [
  { id: 'home-desktop', width: 1440, height: 1720, referenceEnv: 'XP_REF_HOME_DESKTOP_FILE', runnerUrl: import.meta.url, renderCandidate: () => renderLiveDocument('ltr') },
  { id: 'home-phone', width: 390, height: 844, referenceEnv: 'XP_REF_HOME_PHONE_FILE', runnerUrl: import.meta.url, renderCandidate: () => renderLiveDocument('phone') },
]

if (isBoardRunnerMain(import.meta.url)) await runBoardDiagnostics(boardScreens)
