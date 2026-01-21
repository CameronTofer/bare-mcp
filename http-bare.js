/**
 * MCP HTTP Transport for Bare Runtime
 *
 * Uses bare-http1 instead of node:http for Pear/Bare compatibility.
 * WebSocket support requires a Bare-compatible WebSocket server.
 *
 * Usage:
 *   import { createMCPServer } from 'mcp-server'
 *   import { createHttpTransport } from 'mcp-server/http-bare'
 *
 *   const mcp = createMCPServer({ name: 'my-server' })
 *   mcp.addTool({ ... })
 *
 *   const transport = await createHttpTransport(mcp, { port: 3000 })
 */

import http from 'bare-http1'

/**
 * Create HTTP transport for an MCP server (Bare runtime).
 *
 * @param {MCPServer} mcp - MCP server instance from createMCPServer()
 * @param {object} options
 * @param {number} [options.port=3000] - HTTP port
 * @param {string} [options.host='0.0.0.0'] - Bind address
 * @param {function} [options.onActivity] - Activity callback (entry) => void
 * @returns {Promise<HttpTransport>}
 */
export async function createHttpTransport(mcp, options = {}) {
  const {
    port = 3000,
    host = '0.0.0.0',
    onActivity
  } = options

  // Activity tracking
  const activityLog = []
  let requestCount = 0
  const sseClients = new Map() // res -> { id }
  let clientIdCounter = 0

  function generateClientId() {
    return `client-${++clientIdCounter}-${Date.now()}`
  }

  // Handle activity events
  function handleActivity(entry) {
    activityLog.unshift(entry)
    if (activityLog.length > 100) activityLog.pop()
    requestCount++

    broadcastToSseClients({ type: 'activity', ...entry })

    if (onActivity) onActivity(entry)
  }

  mcp.setActivityCallback(handleActivity)

  // Wire up notification callback
  // targets: null = broadcast to all, Set<string> = send only to these client IDs
  mcp.setNotificationCallback((method, params, targets) => {
    const notification = { jsonrpc: '2.0', method, params }
    if (targets === null) {
      broadcastToSseClients(notification)
    } else {
      sendToSseClients(notification, targets)
    }
  })

  // Broadcast to all SSE clients
  function broadcastToSseClients(message) {
    const data = `data: ${JSON.stringify(message)}\n\n`
    for (const [res] of sseClients) {
      try {
        res.write(data)
      } catch (err) {
        console.error('[MCP-HTTP-Bare] SSE send error:', err.message)
      }
    }
  }

  // Send to specific SSE clients by ID
  function sendToSseClients(message, targetIds) {
    const data = `data: ${JSON.stringify(message)}\n\n`
    for (const [res, client] of sseClients) {
      if (targetIds.has(client.id)) {
        try {
          res.write(data)
        } catch (err) {
          console.error('[MCP-HTTP-Bare] SSE send error:', err.message)
        }
      }
    }
  }

  // Collect request body
  function collectBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks).toString()))
      req.on('error', reject)
    })
  }

  // Create HTTP server
  const httpServer = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        status: 'ok',
        server: mcp.name,
        version: mcp.version,
        runtime: 'bare',
        requestCount
      }))
      return
    }

    // Activity endpoint
    if (req.method === 'GET' && req.url === '/activity') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        running: true,
        port,
        requestCount,
        activity: activityLog.slice(0, 50)
      }))
      return
    }

    // Clear activity
    if (req.method === 'POST' && req.url === '/activity/clear') {
      activityLog.length = 0
      requestCount = 0
      broadcastToSseClients({ type: 'cleared' })
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: true }))
      return
    }

    // SSE endpoint
    if (req.method === 'GET' && req.url === '/sse') {
      const clientId = generateClientId()

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')

      res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`)

      sseClients.set(res, { id: clientId })
      console.error(`[MCP-HTTP-Bare] SSE client connected: ${clientId}`)

      req.on('close', () => {
        sseClients.delete(res)
        console.error(`[MCP-HTTP-Bare] SSE client disconnected: ${clientId}`)
      })
      return
    }

    // MCP endpoint (JSON-RPC)
    if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
      try {
        const body = await collectBody(req)
        const request = JSON.parse(body)
        const { jsonrpc, method, params, id } = request

        if (jsonrpc !== '2.0') {
          throw new Error('Invalid JSON-RPC version')
        }

        const result = await mcp.handleRequest(method, params || {})

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', result, id }))
      } catch (err) {
        console.error('[MCP-HTTP-Bare] Request error:', err.message)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: err.message },
          id: null
        }))
      }
      return
    }

    // 404
    res.statusCode = 404
    res.end('Not found')
  })

  // Start listening
  await new Promise((resolve, reject) => {
    httpServer.on('error', reject)
    httpServer.listen(port, host, () => {
      console.error(`[MCP-HTTP-Bare] ${mcp.name} v${mcp.version} listening on http://${host}:${port}`)
      console.error(`[MCP-HTTP-Bare] SSE available at http://${host}:${port}/sse`)
      resolve()
    })
  })

  return {
    port,
    host,
    httpServer,
    sseClients,
    activityLog,
    requestCount: () => requestCount,

    broadcast: broadcastToSseClients,

    async close() {
      broadcastToSseClients({ type: 'shutdown' })
      for (const [res] of sseClients) {
        try { res.end() } catch {}
      }
      sseClients.clear()
      httpServer.close()
    }
  }
}
