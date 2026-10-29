import { handleDeveloperRequest } from './developer-workspace.ts'
import type { DeveloperWorkspaceHelpers } from './developer-workspace.ts'

/** Existing own-principal token authority is the only connected integration read. No external provider is fabricated. */
export async function handleIntegrationWorkspaceRoute(req: Request, url: URL, method: string, helpers: DeveloperWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== '/api/server/panel/integrations') return null
  return handleDeveloperRequest(req, url, method, 'integrations', helpers)
}
