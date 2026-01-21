/**
 * MCP stdio Transport (Bare Runtime)
 *
 * Uses raw stdin/stdout for Pear/Bare compatibility.
 * Reads newline-delimited JSON-RPC messages.
 *
 * This module is auto-selected when importing 'bare-mcp/stdio' under Bare runtime.
 * For explicit import: 'bare-mcp/stdio-bare'
 *
 * Usage:
 *   import { createMCPServer } from 'bare-mcp'
 *   import { createStdioTransport } from 'bare-mcp/stdio'
 *
 *   const mcp = createMCPServer({ name: 'my-server' })
 *   mcp.addTool({ ... })
 *
 *   await createStdioTransport(mcp)
 */

/**
 * Create stdio transport for an MCP server (Bare runtime).
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
    console.error(`[MCP-stdio-Bare] ${entry.tool}: ${entry.success ? 'OK' : 'FAIL'}`)
    if (onActivity) onActivity(entry)
  })

  // Wire up notification callback
  // For stdio, there's only one client, so we always send (ignore targets)
  mcp.setNotificationCallback((method, params, targets) => {
    const notification = { jsonrpc: '2.0', method, params }
    process.stdout.write(JSON.stringify(notification) + '\n')
  })

  console.error(`[MCP-stdio-Bare] ${mcp.name} v${mcp.version} ready`)
  console.error(`[MCP-stdio-Bare] Tools: ${Array.from(mcp.tools.keys()).join(', ')}`)
  console.error(`[MCP-stdio-Bare] Resources: ${mcp.resources.size}, Templates: ${mcp.resourceTemplates.size}`)

  // Buffer for incomplete lines
  let buffer = ''

  // Process a complete line
  async function processLine(line) {
    if (!line.trim()) return

    try {
      const request = JSON.parse(line)
      const { jsonrpc, method, params, id } = request

      if (jsonrpc !== '2.0') {
        throw new Error('Invalid JSON-RPC version')
      }

      const result = await mcp.handleRequest(method, params || {})

      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', result, id }) + '\n')
    } catch (err) {
      console.error('[MCP-stdio-Bare] Error:', err.message)
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: err.message },
        id: null
      }) + '\n')
    }
  }

  // Handle stdin data
  function onData(chunk) {
    buffer += chunk.toString()

    // Process complete lines
    let newlineIndex
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      processLine(line)
    }
  }

  // Handle stdin close
  function onEnd() {
    console.error('[MCP-stdio-Bare] stdin closed')
    if (onClose) onClose()
  }

  // Set up stdin
  process.stdin.on('data', onData)
  process.stdin.on('end', onEnd)
  process.stdin.on('close', onEnd)

  // Bare may need explicit resume
  if (process.stdin.resume) {
    process.stdin.resume()
  }

  return {
    close() {
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('close', onEnd)
    }
  }
}
