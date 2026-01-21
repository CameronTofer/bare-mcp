/**
 * Test runner for Bare runtime
 *
 * Bare doesn't support glob patterns, so we import all test files explicitly.
 * Run with: bare test/run.bare.js
 */

import './core.test.js'
import './notifications.test.js'
import './requests.test.js'
import './rfc6570.test.js'
