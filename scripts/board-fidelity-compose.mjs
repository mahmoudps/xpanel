import { renderLiveDocument } from '../apps/web/src/board-port/xmail-compose.fixture.ts'
import { isBoardRunnerMain, runBoardDiagnostics } from './board-evidence.mjs'

// A partial current-renderer diagnostic, not delivery or provider qualification.
export const boardScreens = [{
  id: 'compose', width: 1440, height: 1520,
  referenceEnv: 'XP_REF_COMPOSE_FILE', runnerUrl: import.meta.url,
  renderCandidate: () => renderLiveDocument('en'),
}]

if (isBoardRunnerMain(import.meta.url)) await runBoardDiagnostics(boardScreens)
