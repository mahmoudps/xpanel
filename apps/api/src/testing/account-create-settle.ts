/**
 * Test seam for POST /api/accounts. An accepted creation (202) is read through GET /api/accounts/operations/:id until it
 * ends, and the answer its POST would have given comes back as a Response. Any other answer is returned unchanged.
 */
export async function settledAccountCreation(response: Response, read: (path: string) => Promise<Response>): Promise<Response> {
  if (response.status !== 202) return response
  const { operation } = await response.json() as { operation: { id: string } }
  for (let attempt = 0; attempt < 2000; attempt++) {
    const view = await (await read(`/api/accounts/operations/${operation.id}`)).json() as { operation?: { status: string }; result?: unknown; problem?: { status: number } }
    if (view.result !== undefined) return new Response(JSON.stringify(view.result), { status: 201, headers: { 'content-type': 'application/json; charset=utf-8' } })
    if (view.problem !== undefined) return new Response(JSON.stringify(view.problem), { status: view.problem.status, headers: { 'content-type': 'application/problem+json; charset=utf-8' } })
    if (view.operation?.status !== 'running') throw new Error(`the account operation ended without its answer: ${view.operation?.status ?? 'unreadable'}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('the account operation did not end')
}
