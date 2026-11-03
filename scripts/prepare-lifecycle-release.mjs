#!/usr/bin/node
// Acquisition always authenticates/extracts with the installed verifier before loading new helper modules.
import { runAcquireLifecycleRelease } from './acquire-lifecycle-release.mjs'
export const runPrepareLifecycleRelease = runAcquireLifecycleRelease
if (import.meta.main) process.exitCode = await runPrepareLifecycleRelease(process.argv.slice(2))
