import { test } from 'vitest'
import { registerEvidenceTests } from './evidence/evidence.test.mjs'

// Run the same assertions in the ordinary portable/unit inventory without a subprocess.
registerEvidenceTests(test)
