import { AsyncLocalStorage } from 'node:async_hooks'

const scope = new AsyncLocalStorage<true>()

/** Stable refusal reason of a deferred background write. */
export const HOST_OPERATION_IN_FLIGHT = 'host_operation_in_flight'

/**
 * Every scheduled or background desired-state write runs inside this scope. Its writer lease is refused while a host
 * operation is bound to the current revision (an account provisioning), so that operation keeps its revision; the
 * writer defers and tries again on its next run. Request handlers write outside this scope.
 */
export const backgroundStateWrite = <T>(write: () => Promise<T>): Promise<T> => scope.run(true, write)
export const isBackgroundStateWrite = (): boolean => scope.getStore() === true
