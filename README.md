# MCP Server Library

A minimal, general-purpose implementation of the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP).

Works on **Node.js** and **Bare runtime** (Pear/Holepunch).

## Features

- **Tools** — Register functions that AI clients can call
- **Resources** — Expose data that clients can read (static or dynamic)
- **Resource Templates** — URI patterns with parameters (`user://{id}`)
- **Notifications** — Push updates to connected clients
- **Subscriptions** — Clients can subscribe to resource changes
- **Multiple Transports** — HTTP, WebSocket, SSE, stdio

## Quick Start

```javascript
import { createMCPServer, z } from './mcp/index.js'
import { createHttpTransport } from './mcp/http.js'

// Create server
const mcp = createMCPServer({
  name: 'my-server',
  version: '1.0.0'
})

// Register a tool
mcp.addTool({
  name: 'greet',
  description: 'Say hello to someone',
  parameters: z.object({
    name: z.string().describe('Name to greet')
  }),
  execute: async ({ name }) => `Hello, ${name}!`
})

// Start HTTP server
await createHttpTransport(mcp, { port: 3000 })
```

## Tools

Tools are functions that AI clients can invoke.

```javascript
mcp.addTool({
  name: 'calculate',
  description: 'Perform arithmetic',
  parameters: z.object({
    a: z.number(),
    b: z.number(),
    op: z.enum(['add', 'subtract', 'multiply', 'divide'])
  }),
  execute: async ({ a, b, op }) => {
    const ops = { add: a + b, subtract: a - b, multiply: a * b, divide: a / b }
    return JSON.stringify({ result: ops[op] })
  }
})

// Register multiple tools
mcp.addTools([tool1, tool2, tool3])
```

## Resources

Resources expose data that clients can read.

### Static Resource

```javascript
mcp.addResource({
  uri: 'config://app',
  name: 'App Configuration',
  description: 'Application settings',
  mimeType: 'application/json',
  text: JSON.stringify({ theme: 'dark', version: '1.0' })
})
```

### Dynamic Resource

```javascript
mcp.addResource({
  uri: 'stats://live',
  name: 'Live Statistics',
  mimeType: 'application/json',
  read: async () => JSON.stringify({
    uptime: process.uptime(),
    memory: process.memoryUsage()
  })
})
```

### Resource Templates

URI patterns that extract parameters:

```javascript
mcp.addResourceTemplate({
  uriTemplate: 'user://{id}',
  name: 'User by ID',
  description: 'Fetch user details',
  mimeType: 'application/json',
  read: async ({ id }) => {
    const user = await db.getUser(id)
    return JSON.stringify(user)
  }
})

// Client can read: user://alice, user://bob, etc.
```

## Notifications

Push updates to connected clients.

```javascript
// Resource was modified
mcp.notifyResourceUpdated('stats://live')

// Resource list changed (added/removed)
mcp.notifyResourceListChanged()

// Tool list changed
mcp.notifyToolListChanged()

// Progress update for long operations
mcp.notifyProgress('upload-token', 50, 100)

// Custom notification
mcp.notify('notifications/custom', { data: 'anything' })
```

## Transports

### HTTP Transport

```javascript
import { createHttpTransport } from './mcp/http.js'

const transport = await createHttpTransport(mcp, {
  port: 3000,
  host: '0.0.0.0',
  websocket: true,  // Enable WebSocket (default: true)
  onActivity: (entry) => console.log('Tool called:', entry.tool)
})

// Endpoints:
// POST /mcp          — JSON-RPC requests
// POST /             — JSON-RPC requests (alias)
// GET  /health       — Health check
// GET  /activity     — Recent tool calls
// GET  /sse          — Server-Sent Events stream
// WS   ws://host:port — WebSocket connection
```

### stdio Transport

For Claude Desktop and similar clients:

```javascript
import { createStdioTransport } from './mcp/stdio.js'

await createStdioTransport(mcp, {
  onActivity: (entry) => console.error('Tool:', entry.tool),
  onClose: () => process.exit(0)
})
```

Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/server.js"]
    }
  }
}
```

## Client Examples

### HTTP (fetch)

```javascript
const response = await fetch('http://localhost:3000/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'greet', arguments: { name: 'World' } },
    id: 1
  })
})
const { result } = await response.json()
```

### WebSocket

```javascript
const ws = new WebSocket('ws://localhost:3000')

ws.onopen = () => {
  // Call a tool
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'greet', arguments: { name: 'World' } },
    id: 1
  }))

  // Subscribe to resource updates
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    method: 'resources/subscribe',
    params: { uri: 'stats://live' },
    id: 2
  }))
}

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  
  if (msg.id) {
    // Response to a request
    console.log('Response:', msg.result)
  } else if (msg.method) {
    // Server notification
    console.log('Notification:', msg.method, msg.params)
  }
}
```

### Server-Sent Events

```javascript
const events = new EventSource('http://localhost:3000/sse')

events.onmessage = (e) => {
  const notification = JSON.parse(e.data)
  console.log('Notification:', notification)
}
```

## MCP Methods

| Method | Description |
|--------|-------------|
| `initialize` | Initialize connection, get capabilities |
| `tools/list` | List available tools |
| `tools/call` | Execute a tool |
| `resources/list` | List available resources |
| `resources/templates/list` | List resource templates |
| `resources/read` | Read a resource by URI |
| `resources/subscribe` | Subscribe to resource updates |
| `resources/unsubscribe` | Unsubscribe from updates |
| `ping` | Health check |

## Notification Types

| Method | Description |
|--------|-------------|
| `notifications/resources/updated` | A resource's content changed |
| `notifications/resources/list_changed` | Resources added/removed |
| `notifications/tools/list_changed` | Tools added/removed |
| `notifications/progress` | Progress update |

## API Reference

### `createMCPServer(options)`

Create an MCP server instance.

```javascript
const mcp = createMCPServer({
  name: 'my-server',           // Server name
  version: '1.0.0',            // Server version
  protocolVersion: '2024-11-05' // MCP protocol version
})
```

Returns an object with:

- `addTool(tool)` / `addTools(tools[])` — Register tools
- `addResource(resource)` / `addResources(resources[])` — Register resources
- `addResourceTemplate(template)` — Register URI template
- `readResource(uri)` — Read a resource
- `notify(method, params)` — Send notification
- `notifyResourceUpdated(uri)` — Notify resource changed
- `notifyResourceListChanged()` — Notify resources added/removed
- `notifyToolListChanged()` — Notify tools added/removed
- `notifyProgress(token, progress, total?)` — Send progress
- `handleRequest(method, params)` — Handle JSON-RPC request

### `createHttpTransport(mcp, options)`

Start HTTP server with WebSocket and SSE support.

```javascript
const transport = await createHttpTransport(mcp, {
  port: 3000,
  host: '0.0.0.0',
  websocket: true,
  onActivity: (entry) => {}
})
```

Returns:

- `port`, `host` — Bound address
- `httpServer` — Node.js HTTP server
- `wss` — WebSocket server
- `broadcast(message)` — Send to all clients
- `close()` — Shutdown server

### `createStdioTransport(mcp, options)`

Start stdio transport for CLI usage.

```javascript
const transport = await createStdioTransport(mcp, {
  onActivity: (entry) => {},
  onClose: () => {}
})
```

## Bare Runtime (Pear)

For Pear apps running on Bare runtime, use the Bare-specific transports:

```javascript
import { createMCPServer } from 'mcp-server'
import { createHttpTransport } from 'mcp-server/http-bare'

const mcp = createMCPServer({ name: 'my-pear-app' })
mcp.addTool({ ... })

await createHttpTransport(mcp, { port: 3000 })
```

### Transports by Runtime

| Runtime | HTTP | stdio |
|---------|------|-------|
| Node.js | `mcp-server/http` | `mcp-server/stdio` |
| Bare | `mcp-server/http-bare` | `mcp-server/stdio-bare` |

### Bare Transport Differences

- **http-bare**: Uses `bare-http1`, SSE only (no WebSocket)
- **stdio-bare**: Uses raw `process.stdin`/`stdout` (no readline)

### Dependencies

For Node.js:
```bash
npm install mcp-server ws
```

For Bare/Pear:
```bash
npm install mcp-server bare-http1
```

## License

MIT
