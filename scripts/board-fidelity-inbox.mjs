import { renderLiveDocument } from '../apps/web/src/board-port/xmail-inbox.fixture.ts'
import { isBoardRunnerMain, runBoardDiagnostics } from './board-evidence.mjs'

// A partial current-renderer diagnostic, not mail authentication qualification.
export const boardScreens = [{
  id: 'inbox', width: 1440, height: 1120,
  referenceEnv: 'XP_REF_INBOX_FILE', runnerUrl: import.meta.url,
  renderCandidate: () => renderLiveDocument('en'),
}]

if (isBoardRunnerMain(import.meta.url)) await runBoardDiagnostics(boardScreens)
