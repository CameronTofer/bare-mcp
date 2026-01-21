# MCP Server Library

A minimal, general-purpose implementation of the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP).

Works on **Node.js** and **Bare runtime** (Pear/Holepunch).

## Features

- **Tools** — Register functions that AI clients can call
- **Resources** — Expose data that clients can read (static or dynamic)
- **Resource Templates** — URI patterns with parameters (`user://{id}`)
- **Annotations** — Metadata hints for tools and content (MCP 2025-11-25)
- **Notifications** — Push updates to connected clients
- **Subscriptions** — Clients can subscribe to resource changes
- **Multiple Transports** — HTTP, WebSocket, SSE, stdio

## Quick Start

```javascript
import { createMCPServer, z } from 'bare-mcp'
import { createHttpTransport } from 'bare-mcp/http'

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

// Start HTTP server (works on both Node.js and Bare)
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

### Tool Annotations

Tools can include annotations that describe their behavior:

```javascript
mcp.addTool({
  name: 'search',
  description: 'Search the web',
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => `Results for: ${query}`,
  annotations: {
    title: 'Web Search',        // Human-readable title
    readOnlyHint: true,         // Doesn't modify environment (default: false)
    openWorldHint: true         // Interacts with external systems (default: true)
  }
})

// Destructive tool example
mcp.addTool({
  name: 'delete_file',
  description: 'Delete a file',
  parameters: z.object({ path: z.string() }),
  execute: async ({ path }) => { /* ... */ },
  annotations: {
    title: 'Delete File',
    readOnlyHint: false,        // Modifies environment
    destructiveHint: true,      // May destroy data (default: true)
    idempotentHint: true,       // Repeated calls have same effect (default: false)
    openWorldHint: false        // Only affects local system
  }
})
```

| Annotation | Default | Description |
|------------|---------|-------------|
| `title` | — | Human-readable display name |
| `readOnlyHint` | `false` | If true, tool doesn't modify its environment |
| `destructiveHint` | `true` | If true, tool may destroy data (only when readOnlyHint=false) |
| `idempotentHint` | `false` | If true, repeated calls have no extra effect (only when readOnlyHint=false) |
| `openWorldHint` | `true` | If true, interacts with external systems |

### Tool Results with Annotations

Tools can return rich content with annotations:

```javascript
mcp.addTool({
  name: 'analyze',
  execute: async () => [{
    type: 'text',
    text: 'Analysis results...',
    annotations: {
      audience: ['user'],           // Who content is for: 'user', 'assistant', or both
      priority: 0.9                  // Importance: 0.0 (optional) to 1.0 (required)
    }
  }]
})

// Return error with content
mcp.addTool({
  name: 'fetch',
  execute: async () => ({
    content: [{ type: 'text', text: 'Connection timeout' }],
    isError: true
  })
})
```

### Error Handling

Tools can throw `MCPError` with specific error codes:

```javascript
import { MCPError, ErrorCode } from 'bare-mcp'

mcp.addTool({
  name: 'get_user',
  parameters: z.object({ id: z.string() }),
  execute: async ({ id }) => {
    const user = await db.findUser(id)
    if (!user) {
      throw new MCPError(
        ErrorCode.INVALID_PARAMS,
        `User not found: ${id}`,
        { userId: id }  // Optional data field
      )
    }
    return JSON.stringify(user)
  }
})

// Custom error codes (use values > -32000)
mcp.addTool({
  name: 'rate_limited_api',
  execute: async () => {
    throw new MCPError(-32001, 'Rate limit exceeded', { retryAfter: 60 })
  }
})
```

**Standard Error Codes:**

| Code | Name | Description |
|------|------|-------------|
| -32700 | `PARSE_ERROR` | Invalid JSON |
| -32600 | `INVALID_REQUEST` | Not a valid JSON-RPC request |
| -32601 | `METHOD_NOT_FOUND` | Method does not exist |
| -32602 | `INVALID_PARAMS` | Invalid parameters (validation, missing args) |
| -32603 | `INTERNAL_ERROR` | Internal server error |
| -32002 | `RESOURCE_NOT_FOUND` | Resource not found |

Error responses follow the JSON-RPC 2.0 spec:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "User not found: abc123",
    "data": { "userId": "abc123" }
  }
}
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

### Resource Annotations

Resources support annotations for display hints and content metadata:

```javascript
mcp.addResource({
  uri: 'doc://readme',
  name: 'README',
  title: 'Project Documentation',     // Human-readable title
  mimeType: 'text/markdown',
  text: '# My Project',
  annotations: {
    audience: ['user'],               // Who content is for
    priority: 0.9,                    // Importance (0.0 to 1.0)
    lastModified: '2025-01-15T10:00:00Z'
  }
})
```

Dynamic resources can return annotations per-read:

```javascript
mcp.addResource({
  uri: 'cache://data',
  name: 'Cached Data',
  read: async () => ({
    text: JSON.stringify(getCachedData()),
    annotations: {
      lastModified: new Date().toISOString(),
      audience: ['assistant']
    }
  })
})
```

| Annotation | Type | Description |
|------------|------|-------------|
| `audience` | `string[]` | Who content is for: `["user"]`, `["assistant"]`, or `["user", "assistant"]` |
| `priority` | `number` | Importance: 0.0 (optional) to 1.0 (required) |
| `lastModified` | `string` | ISO 8601 timestamp of last modification |

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
import { createHttpTransport } from 'bare-mcp/http'

const transport = await createHttpTransport(mcp, {
  port: 3000,
  host: '0.0.0.0',
  websocket: true,  // Enable WebSocket (default: true, Node.js only)
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
import { createStdioTransport } from 'bare-mcp/stdio'

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
  protocolVersion: '2025-11-25' // MCP protocol version
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

This library uses **conditional exports** to support both Node.js and Bare runtime. The correct implementation is selected automatically based on your runtime:

```javascript
import { createMCPServer } from 'bare-mcp'
import { createHttpTransport } from 'bare-mcp/http'  // Auto-selects correct impl
import { createStdioTransport } from 'bare-mcp/stdio'  // Auto-selects correct impl

const mcp = createMCPServer({ name: 'my-app' })
mcp.addTool({ ... })

await createHttpTransport(mcp, { port: 3000 })
```

The `"bare"` export condition (recognized by Bare's module system) selects the Bare implementation; otherwise the Node.js implementation is used.

### Explicit Imports

If you need to explicitly select a runtime implementation:

| Transport | Node.js | Bare |
|-----------|---------|------|
| HTTP | `bare-mcp/http-node` | `bare-mcp/http-bare` |
| stdio | `bare-mcp/stdio-node` | `bare-mcp/stdio-bare` |

### Transport Differences

- **http (Node.js)**: Uses `node:http` + `ws`, supports WebSocket and SSE
- **http (Bare)**: Uses `bare-http1`, SSE only (no WebSocket)
- **stdio (Node.js)**: Uses `node:readline`
- **stdio (Bare)**: Uses raw `process.stdin`/`stdout`

### Dependencies

For Node.js:
```bash
npm install bare-mcp ws
```

For Bare/Pear:
```bash
npm install bare-mcp bare-http1
```

## License

MIT
