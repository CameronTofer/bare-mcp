/**
 * MCP stdio Transport (auto-detecting runtime)
 *
 * Uses which-runtime to detect Node.js vs Bare and imports the correct
 * implementation. Downstream packages just import this — no need to
 * worry about which runtime they're on.
 *
 * Usage:
 *   import { createStdioTransport } from 'bare-mcp/stdio'
 *
 *   await createStdioTransport(mcp)
 */

import { isBare } from 'which-runtime'

const { createStdioTransport } = isBare
  ? await import('./stdio-bare.js')
  : await import('./stdio-node.js')

export { createStdioTransport }
