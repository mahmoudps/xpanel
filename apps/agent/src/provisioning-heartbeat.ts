/** Interval of the keepalive bytes; both peers' idle budget (AGENT_ROUTE_TIMEOUT_MS) is many intervals long. */
export const PROVISIONING_HEARTBEAT_MS = 10_000

const SPACE = new Uint8Array([0x20])

/**
 * Account provisioning answers when its host work ends, which a slow host can stretch past any fixed request
 * budget; an API that gave up then retired the job under work still in progress. A reply ready within one
 * interval is returned as it is. Later, the reply becomes a 200 stream: a space every interval keeps both
 * sockets' idle timeouts from firing while the agent works, and the JSON reply follows (JSON.parse skips leading
 * whitespace). A refusal after that point ends the stream unfinished, which the API reads as an unverified outcome.
 */
export async function withProvisioningHeartbeat(work: Promise<Response>, intervalMs = PROVISIONING_HEARTBEAT_MS): Promise<Response> {
  let wait: ReturnType<typeof setTimeout> | undefined
  const early = await Promise.race([
    work.then(response => ({ response })),
    new Promise<null>(resolve => { wait = setTimeout(resolve, intervalMs, null) }),
  ]).finally(() => clearTimeout(wait))
  if (early) return early.response
  let beat: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(SPACE)
      beat = setInterval(() => controller.enqueue(SPACE), intervalMs)
      work.then(async response => {
        if (!response.ok) throw new Error('account provisioning refused after its keepalive started')
        const reply = new Uint8Array(await response.arrayBuffer())
        clearInterval(beat)
        controller.enqueue(reply)
        controller.close()
      }).catch((error: unknown) => {
        clearInterval(beat)
        try { controller.error(error) } catch { /* the reader already cancelled */ }
      })
    },
    cancel() { clearInterval(beat) },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
