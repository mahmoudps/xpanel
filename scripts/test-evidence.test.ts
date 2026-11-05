import { test } from 'vitest'
import { registerEvidenceTests } from './evidence/evidence.test.mjs'
import { registerStatusTests } from './evidence/status.test.mjs'

// Run the same assertions in the ordinary portable/unit inventory without a subprocess.
registerEvidenceTests(test)
registerStatusTests(test)
