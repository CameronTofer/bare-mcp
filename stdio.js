/**
 * MCP stdio Transport
 *
 * Runs an MCP server over stdin/stdout for Claude Desktop and similar clients.
 * JSON-RPC messages are sent one per line.
 *
 * Notifications are sent as JSON-RPC messages without an `id` field.
 *
 * Usage:
 *   import { createMCPServer } from './mcp/index.js'
 *   import { createStdioTransport } from './mcp/stdio.js'
 *
 *   const mcp = createMCPServer({ name: 'my-server' })
 *   mcp.addTool({ ... })
 *
 *   await createStdioTransport(mcp)
 *
 *   // Push notification to client
 *   mcp.notifyResourceUpdated('myapp://data')
 */

import readline from 'node:readline'

/**
 * Create stdio transport for an MCP server.
 *
 * @param {MCPServer} mcp - MCP server instance from createMCPServer()
 * @param {object} options
 * @param {function} [options.onActivity] - Activity callback (entry) => void
 * @param {function} [options.onClose] - Called when stdin closes
 * @returns {Promise<StdioTransport>}
 */
export async function createStdioTransport(mcp, options = {}) {
  const { onActivity, onClose } = options

  // Wire up activity callback
  mcp.setActivityCallback((entry) => {
    console.error(`[MCP-stdio] ${entry.tool}: ${entry.success ? 'OK' : 'FAIL'}`)
    if (onActivity) onActivity(entry)
  })

  // Wire up notification callback - send as JSON-RPC notification (no id)
  // For stdio, there's only one client, so we always send (ignore targets)
  mcp.setNotificationCallback((method, params, targets) => {
    const notification = { jsonrpc: '2.0', method, params }
    console.log(JSON.stringify(notification))
  })

  // Set up readline for stdin
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  })

  console.error(`[MCP-stdio] ${mcp.name} v${mcp.version} ready`)
  console.error(`[MCP-stdio] Tools: ${Array.from(mcp.tools.keys()).join(', ')}`)
  console.error(`[MCP-stdio] Resources: ${mcp.resources.size}, Templates: ${mcp.resourceTemplates.size}`)

  // Process each line as a JSON-RPC request
  rl.on('line', async (line) => {
    try {
      const request = JSON.parse(line)
      const { jsonrpc, method, params, id } = request

      if (jsonrpc !== '2.0') {
        throw new Error('Invalid JSON-RPC version')
      }

      const result = await mcp.handleRequest(method, params || {})

      // Write response to stdout (one line)
      console.log(JSON.stringify({ jsonrpc: '2.0', result, id }))
    } catch (err) {
      console.error('[MCP-stdio] Error:', err.message)
      console.log(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: err.message },
        id: null
      }))
    }
  })

  rl.on('close', () => {
    console.error('[MCP-stdio] stdin closed')
    if (onClose) onClose()
  })

  return {
    readline: rl,

    close() {
      rl.close()
    }
  }
}
