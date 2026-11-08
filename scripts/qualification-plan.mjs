import { specs, tools } from '../packages/catalog/src/data/index.ts'
import { PROFILE_EXCLUSIONS } from '../packages/catalog/src/delivery.ts'
import { PHASE1_TOOL_PROBES } from '../packages/catalog/src/host-qualification.ts'
import { requireValue, validateRequirements } from './evidence/contracts.mjs'
import { DRIVERS, QUALIFICATION_INVENTORY } from './qualification-drivers/index.mjs'
import { REQUIRED_PROFILES } from './evidence/shared.mjs'

export { QUALIFICATION_INVENTORY }

/** The stage/environment slots that one passed report of each runner slot backs. */
export const RUNNER_SLOTS = Object.freeze({
  unit: Object.freeze([{ stage: 'implemented', environment: 'unit' }]),
  host: Object.freeze([{ stage: 'integrated', environment: 'http' }, { stage: 'verified', environment: 'linux' }]),
  browser: Object.freeze([{ stage: 'integrated', environment: 'browser' }, { stage: 'verified', environment: 'browser' }]),
  external: Object.freeze([{ stage: 'verified', environment: 'external' }]),
})

export const slotCheckIds = (toolId, slot) => {
  const inventory = QUALIFICATION_INVENTORY[toolId]
  requireValue(inventory !== undefined && Object.hasOwn(RUNNER_SLOTS, slot), 'No reviewed qualification driver for this tool and slot')
  return slot === 'unit' ? inventory.unit.map(check => check.id) : [...inventory[slot]]
}

/** Reviewed requirements for record, status and aggregation: exact catalog acceptance plus the profile subset. */
export function qualificationRequirements(toolIds = Object.keys(QUALIFICATION_INVENTORY)) {
  return validateRequirements(toolIds.map(toolId => {
    const spec = specs.find(item => item.id === toolId)
    requireValue(Object.hasOwn(QUALIFICATION_INVENTORY, toolId) && spec !== undefined, `No reviewed qualification driver for ${toolId}`)
    const host = slotCheckIds(toolId, 'host')
    const exclusion = Object.hasOwn(PROFILE_EXCLUSIONS, toolId) ? PROFILE_EXCLUSIONS[toolId] : undefined
    return {
      toolId, acceptance: spec.acceptance,
      checks: { unit: slotCheckIds(toolId, 'unit'), http: host, browser: slotCheckIds(toolId, 'browser'), linux: host, external: slotCheckIds(toolId, 'external') },
      ...(exclusion === undefined ? {} : { profiles: REQUIRED_PROFILES.filter(profile => !exclusion.profiles.includes(profile)) }),
    }
  }))
}

/** Host readiness probes that keep a tool's published evidence live; null means the catalog would demote it. */
export const readinessProbes = toolId => Object.hasOwn(PHASE1_TOOL_PROBES, toolId) ? [...PHASE1_TOOL_PROBES[toolId]] : null

/** Plan for one slot: tools with a driver run, every other requested catalog tool is listed as not run. */
export function qualificationPlan(slot, requested = 'all') {
  requireValue(Object.hasOwn(RUNNER_SLOTS, slot), 'Use --slot=unit, host, browser or external')
  const inScope = tools.filter(tool => tool.status !== 'out-of-scope').map(tool => tool.id)
  const ids = requested === 'all' ? inScope : requested.split(',')
  requireValue(ids.length > 0 && new Set(ids).size === ids.length && ids.every(id => inScope.includes(id)), 'Requested tools must be unique in-scope catalog tool IDs')
  const driven = ids.filter(id => Object.hasOwn(QUALIFICATION_INVENTORY, id))
  return {
    slot, receipts: RUNNER_SLOTS[slot],
    // Shared state runs last, so a failed restore can only stop drivers that would have touched it.
    tools: driven.map(toolId => ({ toolId, checks: slotCheckIds(toolId, slot), readiness: readinessProbes(toolId), requires_qualification_admission: DRIVERS[toolId].requires_qualification_admission, shared: DRIVERS[toolId].restores.length > 0 })).sort((left, right) => Number(left.shared) - Number(right.shared)),
    notRun: ids.filter(id => !driven.includes(id)).map(toolId => ({ toolId, reason: 'no reviewed acceptance driver', readiness: readinessProbes(toolId) })),
  }
}
