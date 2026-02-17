/**
 * MCP HTTP Transport (auto-detecting runtime)
 *
 * Uses which-runtime to detect Node.js vs Bare and imports the correct
 * implementation. Downstream packages just import this — no need to
 * worry about which runtime they're on.
 *
 * Usage:
 *   import { createHttpTransport } from 'bare-mcp/http'
 *
 *   const transport = await createHttpTransport(mcp, { port: 3000 })
 */

import { isBare } from 'which-runtime'

const { createHttpTransport } = isBare
  ? await import('./http-bare.js')
  : await import('./http-node.js')

export { createHttpTransport }
