/**
 * Tools that have a screen and a passing acceptance test, keyed by tool id → test name.
 * This is the only place readiness is declared; `catalogTools` derives status from it.
 */
export const readyTools: Readonly<Record<string, string>> = {}
