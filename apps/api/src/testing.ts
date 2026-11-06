export const TEST_AGENT_TOKEN = 'a'.repeat(64)
export const TEST_SERVER_SECRET = 'integration-test-server-secret-at-least-32-bytes'

/** Stands in for the host agent apply route with a scripted reconcile result; rendering is covered by the agent's own tests. */
export const scriptedApplyAgent = () => {
  const agent = { applies: 0, reply: { status: 'applied' } as Record<string, unknown>, subscribe: () => () => undefined,
    fetch: async (request: Request): Promise<Response> => {
      if (new URL(request.url).pathname !== '/state/apply') return Response.json({ code: 'NOT_FOUND' }, { status: 404 })
      agent.applies++
      return Response.json(agent.reply, { status: agent.reply.status === 'failed' ? 422 : 200 })
    } }
  return agent
}
