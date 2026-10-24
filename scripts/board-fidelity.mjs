import { renderLiveDocument } from '../apps/web/src/board-port/xwhm-dashboard.ts'
import { boardScreens as homeScreens } from './board-fidelity-home.mjs'
import { boardScreens as inboxScreens } from './board-fidelity-inbox.mjs'
import { boardScreens as composeScreens } from './board-fidelity-compose.mjs'
import { isBoardRunnerMain, runBoardDiagnostics } from './board-evidence.mjs'

// External reference files stay local. This aggregate is a synthetic diagnostic,
// never authenticated production or Arabic interaction qualification.
export const boardScreens = [{
  id: 'dashboard', width: 1440, height: 1820,
  referenceEnv: 'XP_BOARD_FILE', runnerUrl: import.meta.url,
  renderCandidate: () => renderLiveDocument('ltr'),
}]

if (isBoardRunnerMain(import.meta.url)) {
  await runBoardDiagnostics([...boardScreens, ...homeScreens, ...inboxScreens, ...composeScreens], { aggregate: true })
}
