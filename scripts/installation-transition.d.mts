import type { PreparedReleaseCapability } from './prepared-release.mjs'
declare const transitionBrand: unique symbol
export interface InstallationTransitionCapability { readonly [transitionBrand]: true }
export function classifyInstallationImage(actual: unknown, previous: unknown, selected: unknown): 'foreign' | 'previous' | 'selected'
export function projectSelectedInstallationReceipt(prior: unknown, selected: unknown, files: unknown, reference: string): Readonly<Record<string, unknown>>
export function prepareInstallationTransition(capability: unknown, prepared: PreparedReleaseCapability): Promise<InstallationTransitionCapability>
export function selectInstallationTransition(token: InstallationTransitionCapability, selection: 'target' | 'previous'): Promise<Readonly<Record<string, unknown>>>
export function publishInstallationTransition(token: InstallationTransitionCapability, hostOutcome: 'succeeded' | 'rolled_back'): Promise<Readonly<Record<string, unknown>>>
export function parseInstallationTransitionJournal(value: unknown, operationId: string): Readonly<Record<string, unknown>>
export function inspectInstallationTransition(operationId: string): Promise<Readonly<Record<string, unknown>>>
export function readInstallationTransitionRecovery(operationId: string): Promise<Readonly<Record<string, unknown>>>
export function reopenInstallationTransition(capability: unknown, prepared: PreparedReleaseCapability, capture: unknown): Promise<InstallationTransitionCapability>
