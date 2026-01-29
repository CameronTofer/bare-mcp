/**
 * MCP HTTP Transport (Bare Runtime)
 *
 * Uses bare-http1 instead of node:http for Pear/Bare compatibility.
 * SSE only (no WebSocket).
 *
 * This module is auto-selected when importing 'bare-mcp/http' under Bare runtime.
 * For explicit import: 'bare-mcp/http-bare'
 *
 * Usage:
 *   import { createMCPServer } from 'bare-mcp'
 *   import { createHttpTransport } from 'bare-mcp/http'
 *
 *   const mcp = createMCPServer({ name: 'my-server' })
 *   mcp.addTool({ ... })
 *
 *   const transport = await createHttpTransport(mcp, { port: 3000 })
 */

import http from 'bare-http1'
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
  return {
    jsonrpc: '2.0',
    error: { code: ErrorCode.INTERNAL_ERROR, message: err.message },
    id
  }
}

/**
 * Create HTTP transport for an MCP server (Bare runtime).
 *
 * @param {MCPServer} mcp - MCP server instance from createMCPServer()
 * @param {object} options
 * @param {number} [options.port=3000] - HTTP port
 * @param {string} [options.host='0.0.0.0'] - Bind address
 * @param {boolean} [options.verbose=false] - Enable verbose logging of requests/notifications
 * @param {function} [options.onActivity] - Activity callback (entry) => void
 * @returns {Promise<HttpTransport>}
 */
export async function createHttpTransport(mcp, options = {}) {
  const {
    port = 3000,
    host = '0.0.0.0',
    verbose = false,
    onActivity
  } = options

  const log = verbose
    ? (msg, ...args) => console.error(`[MCP-HTTP-Bare] ${msg}`, ...args)
    : () => {}

  // Activity tracking
  const activityLog = []
  let requestCount = 0
  const sseClients = new Map() // res -> { id }
  let clientIdCounter = 0

  function generateClientId() {
    return `client-${++clientIdCounter}-${Date.now()}`
  }

  // Handle activity events (internal tracking only, not broadcast via MCP SSE)
  function handleActivity(entry) {
    activityLog.unshift(entry)
    if (activityLog.length > 100) activityLog.pop()
    requestCount++

    // Activity is tracked internally, available via /activity endpoint
    // Not broadcast via SSE as it's not part of MCP protocol
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

  // Broadcast to all SSE clients (MCP SSE format: event: message)
  function broadcastToSseClients(message) {
    const data = `event: message\ndata: ${JSON.stringify(message)}\n\n`
    for (const [res] of sseClients) {
      try {
        res.write(data)
      } catch (err) {
        console.error('[MCP-HTTP-Bare] SSE send error:', err.message)
      }
    }
  }

  // Send to specific SSE clients by ID (MCP SSE format: event: message)
  function sendToSseClients(message, targetIds) {
    const data = `event: message\ndata: ${JSON.stringify(message)}\n\n`
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

    // SSE endpoint - MCP SSE Transport Protocol
    if (req.method === 'GET' && req.url.startsWith('/sse')) {
      const clientId = generateClientId()

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')

      // MCP SSE protocol: send endpoint event with POST URL
      // The client will POST JSON-RPC messages to this URL
      const messageEndpoint = `http://${req.headers.host}/message?sessionId=${clientId}`
      res.write(`event: endpoint\ndata: ${messageEndpoint}\n\n`)

      sseClients.set(res, { id: clientId })
      console.error(`[MCP-HTTP-Bare] SSE client connected: ${clientId}`)

      req.on('close', () => {
        sseClients.delete(res)
        console.error(`[MCP-HTTP-Bare] SSE client disconnected: ${clientId}`)
      })
      return
    }

    // MCP SSE message endpoint - receives JSON-RPC POSTs and sends responses via SSE
    if (req.method === 'POST' && req.url.startsWith('/message')) {
      const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams
      const sessionId = urlParams.get('sessionId')
      
      // Find the SSE client for this session
      let sseRes = null
      for (const [res, client] of sseClients) {
        if (client.id === sessionId) {
          sseRes = res
          break
        }
      }

      let id = null
      try {
        const body = await collectBody(req)
        let request
        try {
          request = JSON.parse(body)
        } catch (parseErr) {
          throw new MCPError(ErrorCode.PARSE_ERROR, 'Invalid JSON')
        }

        id = request.id
        const { jsonrpc, method, params } = request
        const isNotification = id === undefined || id === null

        if (jsonrpc !== '2.0') {
          throw new MCPError(ErrorCode.INVALID_REQUEST, 'Invalid JSON-RPC version')
        }

        log(isNotification ? `← notification: ${method}` : `← request[${id}]: ${method}`, params || {})

        const result = await mcp.handleRequest(method, params || {})

        // Send response via SSE if we have a session, otherwise via HTTP response
        if (sseRes && !isNotification) {
          const response = { jsonrpc: '2.0', result, id }
          sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`)
          log(`→ response[${id}] via SSE:`, result)
        }

        // Always send HTTP 202 Accepted for SSE transport
        res.statusCode = 202
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ accepted: true }))
      } catch (err) {
        console.error('[MCP-HTTP-Bare] SSE message error:', err.message)
        
        // Send error via SSE if possible
        if (sseRes && id !== null) {
          sseRes.write(`event: message\ndata: ${JSON.stringify(errorToJsonRpc(err, id))}\n\n`)
        }
        
        res.statusCode = 202
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ accepted: true }))
      }
      return
    }

    // MCP endpoint (JSON-RPC)
    if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
      let id = null
      try {
        const body = await collectBody(req)
        let request
        try {
          request = JSON.parse(body)
        } catch (parseErr) {
          throw new MCPError(ErrorCode.PARSE_ERROR, 'Invalid JSON')
        }

        id = request.id
        const { jsonrpc, method, params } = request
        const isNotification = id === undefined || id === null

        if (jsonrpc !== '2.0') {
          throw new MCPError(ErrorCode.INVALID_REQUEST, 'Invalid JSON-RPC version')
        }

        // Verbose logging
        if (isNotification) {
          log(`← notification: ${method}`, params || {})
        } else {
          log(`← request[${id}]: ${method}`, params || {})
        }

        const result = await mcp.handleRequest(method, params || {})

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        // For notifications (no id), return 204 No Content per HTTP semantics
        if (isNotification) {
          log(`→ notification handled (204 No Content)`)
          res.statusCode = 204
          res.end()
        } else {
          log(`→ response[${id}]:`, result)
          res.end(JSON.stringify({ jsonrpc: '2.0', result, id }))
        }
      } catch (err) {
        console.error('[MCP-HTTP-Bare] Request error:', err.message)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(errorToJsonRpc(err, id)))
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
