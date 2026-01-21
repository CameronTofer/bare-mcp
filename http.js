/**
 * MCP HTTP Transport (Node.js)
 *
 * Exposes an MCP server over HTTP with multiple notification transports:
 * - WebSocket: Bidirectional, used for subscriptions and real-time updates
 * - SSE: Server-Sent Events for simple server→client push
 *
 * Usage:
 *   import { createMCPServer } from 'bare-mcp'
 *   import { createHttpTransport } from 'bare-mcp/http'
 *
 *   const mcp = createMCPServer({ name: 'my-server' })
 *   mcp.addTool({ ... })
 *
 *   const transport = await createHttpTransport(mcp, { port: 3000 })
 *
 *   // Push notifications to clients
 *   mcp.notifyResourceUpdated('data://resource/123')
 */

import http from 'node:http'
import { WebSocketServer } from 'ws'
import { MCPError, ErrorCode } from './index.js'

/**
 * Convert an error to JSON-RPC error format.
 */
function errorToJsonRpc(err, id) {
  if (err instanceof MCPError) {
    return {
      jsonrpc: '2.0',
      error: err.toJSON(),
      id
    }
  }
  // Unknown error - wrap as internal error
  return {
    jsonrpc: '2.0',
    error: { code: ErrorCode.INTERNAL_ERROR, message: err.message },
    id
  }
}

/**
 * Create HTTP transport for an MCP server.
 *
 * @param {MCPServer} mcp - MCP server instance from createMCPServer()
 * @param {object} options
 * @param {number} [options.port=3000] - HTTP port
 * @param {string} [options.host='0.0.0.0'] - Bind address
 * @param {boolean} [options.websocket=true] - Enable WebSocket support
 * @param {function} [options.onActivity] - Activity callback (entry) => void
 * @returns {Promise<HttpTransport>}
 */
export async function createHttpTransport(mcp, options = {}) {
  const {
    port = 3000,
    host = '0.0.0.0',
    websocket = true,
    onActivity
  } = options

  // Client tracking
  const activityLog = []
  let requestCount = 0
  const wsClients = new Map()  // ws -> { id, subscriptions }
  const sseClients = new Map() // res -> { id }
  let clientIdCounter = 0

  // Generate unique client ID
  function generateClientId() {
    return `client-${++clientIdCounter}-${Date.now()}`
  }

  // Handle activity events
  function handleActivity(entry) {
    activityLog.unshift(entry)
    if (activityLog.length > 100) activityLog.pop()
    requestCount++

    // Broadcast to WebSocket clients
    broadcastToWsClients({ type: 'activity', ...entry })

    // Call user-provided callback
    if (onActivity) onActivity(entry)
  }

  // Wire up activity callback
  mcp.setActivityCallback(handleActivity)

  // Wire up notification callback
  // targets: null = broadcast to all, Set<string> = send only to these client IDs
  mcp.setNotificationCallback((method, params, targets) => {
    const notification = {
      jsonrpc: '2.0',
      method,
      params
    }

    if (targets === null) {
      // Broadcast to all clients
      broadcastToWsClients(notification)
      broadcastToSseClients(notification)
    } else {
      // Send to specific clients only
      sendToWsClients(notification, targets)
      sendToSseClients(notification, targets)
    }
  })

  // Broadcast to all WebSocket clients
  function broadcastToWsClients(message) {
    const data = JSON.stringify(message)
    for (const [ws] of wsClients) {
      try {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(data)
        }
      } catch (err) {
        console.error('[MCP-HTTP] WebSocket send error:', err.message)
      }
    }
  }

  // Send to specific WebSocket clients by ID
  function sendToWsClients(message, targetIds) {
    const data = JSON.stringify(message)
    for (const [ws, client] of wsClients) {
      if (targetIds.has(client.id)) {
        try {
          if (ws.readyState === 1) {
            ws.send(data)
          }
        } catch (err) {
          console.error('[MCP-HTTP] WebSocket send error:', err.message)
        }
      }
    }
  }

  // Broadcast to all SSE clients
  function broadcastToSseClients(message) {
    const data = `data: ${JSON.stringify(message)}\n\n`
    for (const [res] of sseClients) {
      try {
        res.write(data)
      } catch (err) {
        console.error('[MCP-HTTP] SSE send error:', err.message)
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
          console.error('[MCP-HTTP] SSE send error:', err.message)
        }
      }
    }
  }

  // Broadcast to all clients (WS + SSE)
  function broadcastToClients(message) {
    broadcastToWsClients(message)
    broadcastToSseClients(message)
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
      broadcastToClients({ type: 'cleared' })
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: true }))
      return
    }

    // SSE endpoint for server-to-client notifications
    if (req.method === 'GET' && req.url === '/sse') {
      const clientId = generateClientId()

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()

      // Send initial connection event
      res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`)

      sseClients.set(res, { id: clientId })
      console.error(`[MCP-HTTP] SSE client connected: ${clientId}`)

      req.on('close', () => {
        sseClients.delete(res)
        console.error(`[MCP-HTTP] SSE client disconnected: ${clientId}`)
      })
      return
    }

    // MCP endpoint (JSON-RPC)
    if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        let id = null
        try {
          let request
          try {
            request = JSON.parse(body)
          } catch (parseErr) {
            throw new MCPError(ErrorCode.PARSE_ERROR, 'Invalid JSON')
          }

          id = request.id
          const { jsonrpc, method, params } = request

          if (jsonrpc !== '2.0') {
            throw new MCPError(ErrorCode.INVALID_REQUEST, 'Invalid JSON-RPC version')
          }

          const result = await mcp.handleRequest(method, params || {})

          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ jsonrpc: '2.0', result, id }))
        } catch (err) {
          console.error('[MCP-HTTP] Request error:', err.message)
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(errorToJsonRpc(err, id)))
        }
      })
      return
    }

    // 404
    res.statusCode = 404
    res.end('Not found')
  })

  // WebSocket support
  let wss = null
  if (websocket) {
    wss = new WebSocketServer({ server: httpServer })

    wss.on('connection', (ws, req) => {
      const clientId = generateClientId()
      console.error(`[MCP-HTTP] WebSocket client connected: ${clientId} from ${req.socket.remoteAddress}`)

      wsClients.set(ws, { id: clientId, subscriptions: new Set() })

      // Send current status
      ws.send(JSON.stringify({
        type: 'connected',
        clientId,
        running: true,
        port,
        server: mcp.name,
        requestCount,
        activity: activityLog.slice(0, 50)
      }))

      ws.on('close', () => {
        const client = wsClients.get(ws)
        if (client) {
          // Unsubscribe from all resources
          for (const uri of client.subscriptions) {
            mcp.unsubscribe(uri, clientId)
          }
        }
        wsClients.delete(ws)
        console.error(`[MCP-HTTP] WebSocket client disconnected: ${clientId}`)
      })

      ws.on('error', (err) => {
        console.error('[MCP-HTTP] WebSocket error:', err.message)
        wsClients.delete(ws)
      })

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString())

          // Handle legacy activity clear
          if (msg.type === 'clear') {
            activityLog.length = 0
            requestCount = 0
            broadcastToClients({ type: 'cleared' })
            return
          }

          // Handle JSON-RPC requests over WebSocket
          if (msg.jsonrpc === '2.0' && msg.method) {
            const { method, params, id } = msg
            try {
              // Inject subscriber ID for subscription methods
              const enrichedParams = { ...params, _subscriberId: clientId }
              const result = await mcp.handleRequest(method, enrichedParams)

              // Track subscriptions locally
              if (method === 'resources/subscribe' && params?.uri) {
                const client = wsClients.get(ws)
                if (client) client.subscriptions.add(params.uri)
              } else if (method === 'resources/unsubscribe' && params?.uri) {
                const client = wsClients.get(ws)
                if (client) client.subscriptions.delete(params.uri)
              }

              ws.send(JSON.stringify({ jsonrpc: '2.0', result, id }))
            } catch (err) {
              ws.send(JSON.stringify(errorToJsonRpc(err, id)))
            }
          }
        } catch (err) {
          console.error('[MCP-HTTP] WebSocket parse error:', err.message)
        }
      })
    })
  }

  // Start listening
  await new Promise((resolve, reject) => {
    httpServer.on('error', reject)
    httpServer.listen(port, host, () => {
      console.error(`[MCP-HTTP] ${mcp.name} v${mcp.version} listening on http://${host}:${port}`)
      if (websocket) {
        console.error(`[MCP-HTTP] WebSocket available at ws://${host}:${port}`)
      }
      resolve()
    })
  })

  // Return transport handle
  return {
    port,
    host,
    httpServer,
    wss,
    wsClients,
    sseClients,
    activityLog,
    requestCount: () => requestCount,

    // Broadcast methods
    broadcast: broadcastToClients,
    broadcastWs: broadcastToWsClients,
    broadcastSse: broadcastToSseClients,

    async close() {
      broadcastToClients({ type: 'shutdown' })

      // Close WebSocket clients
      for (const [ws] of wsClients) {
        try { ws.close() } catch {}
      }
      wsClients.clear()

      // Close SSE clients
      for (const [res] of sseClients) {
        try { res.end() } catch {}
      }
      sseClients.clear()

      httpServer.close()
    }
  }
}
