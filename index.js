/**
 * General-Purpose MCP Server Library
 *
 * A minimal, reusable implementation of the Model Context Protocol (MCP).
 * Works on both Node.js and Bare runtime (Pear/Holepunch).
 *
 * Usage:
 *   import { createMCPServer } from 'bare-mcp'
 *
 *   const mcp = createMCPServer({ name: 'my-server', version: '1.0.0' })
 *
 *   // Register tools
 *   mcp.addTool({
 *     name: 'greet',
 *     description: 'Say hello',
 *     parameters: z.object({ name: z.string() }),
 *     execute: async ({ name }) => `Hello, ${name}!`
 *   })
 *
 *   // Register static resources
 *   mcp.addResource({
 *     uri: 'config://settings',
 *     name: 'Settings',
 *     description: 'Application settings',
 *     mimeType: 'application/json',
 *     text: JSON.stringify({ theme: 'dark' })
 *   })
 *
 *   // Register dynamic resources (content generated on read)
 *   mcp.addResource({
 *     uri: 'stats://current',
 *     name: 'Current Stats',
 *     read: async () => JSON.stringify({ uptime: process.uptime() })
 *   })
 *
 *   // Register resource templates (URI patterns)
 *   mcp.addResourceTemplate({
 *     uriTemplate: 'user://{id}',
 *     name: 'User by ID',
 *     description: 'Fetch user details',
 *     read: async (params) => JSON.stringify(await getUser(params.id))
 *   })
 *
 *   // Then use with a transport (auto-selects correct implementation):
 *   import { createHttpTransport } from 'bare-mcp/http'
 *   await createHttpTransport(mcp, { port: 3000 })
 */

import { z } from 'zod'

// ============================================================================
// MCP Error Codes (JSON-RPC 2.0 + MCP-specific)
// ============================================================================

/**
 * Standard JSON-RPC 2.0 error codes
 */
export const ErrorCode = {
  // JSON-RPC 2.0 standard errors
  PARSE_ERROR: -32700,       // Invalid JSON
  INVALID_REQUEST: -32600,   // Not a valid Request object
  METHOD_NOT_FOUND: -32601,  // Method does not exist
  INVALID_PARAMS: -32602,    // Invalid method parameters
  INTERNAL_ERROR: -32603,    // Internal JSON-RPC error

  // MCP-specific errors (-32000 to -32099 reserved for implementation)
  RESOURCE_NOT_FOUND: -32002 // Resource not found
}

/**
 * MCP Error class for throwing errors with specific codes.
 *
 * Tool handlers can throw this to return specific error codes:
 *
 * @example
 * throw new MCPError(ErrorCode.INVALID_PARAMS, 'Missing required field: name')
 *
 * @example
 * throw new MCPError(-32001, 'Rate limit exceeded', { retryAfter: 60 })
 */
export class MCPError extends Error {
  /**
   * @param {number} code - JSON-RPC error code
   * @param {string} message - Human-readable error message
   * @param {object} [data] - Optional additional error data
   */
  constructor(code, message, data) {
    super(message)
    this.name = 'MCPError'
    this.code = code
    this.data = data
  }

  /**
   * Convert to JSON-RPC error object format.
   */
  toJSON() {
    const error = { code: this.code, message: this.message }
    if (this.data !== undefined) {
      error.data = this.data
    }
    return error
  }
}

// ============================================================================
// Zod to JSON Schema Conversion
// ============================================================================

/**
 * Convert Zod schema to JSON Schema for MCP tool definitions.
 * Supports common Zod types: object, string, number, boolean, enum, optional, union, array.
 */
export function zodToJsonSchema(schema) {
  if (schema instanceof z.ZodObject) {
    const shape = schema._def.shape()
    const properties = {}
    const required = []

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value)
      if (!(value instanceof z.ZodOptional)) {
        required.push(key)
      }
    }

    const result = { type: 'object', properties }
    if (required.length) result.required = required
    if (schema._def.description) result.description = schema._def.description
    return result
  }

  if (schema instanceof z.ZodString) {
    const result = { type: 'string' }
    if (schema._def.description) result.description = schema._def.description
    return result
  }

  if (schema instanceof z.ZodNumber) {
    const result = { type: 'number' }
    if (schema._def.description) result.description = schema._def.description
    return result
  }

  if (schema instanceof z.ZodBoolean) {
    const result = { type: 'boolean' }
    if (schema._def.description) result.description = schema._def.description
    return result
  }

  if (schema instanceof z.ZodEnum) {
    const result = { type: 'string', enum: schema._def.values }
    if (schema._def.description) result.description = schema._def.description
    return result
  }

  if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema(schema._def.innerType)
  }

  if (schema instanceof z.ZodUnion) {
    return { anyOf: schema._def.options.map(zodToJsonSchema) }
  }

  if (schema instanceof z.ZodArray) {
    const result = { type: 'array', items: zodToJsonSchema(schema._def.type) }
    if (schema._def.description) result.description = schema._def.description
    return result
  }

  // Fallback for unsupported types
  return { type: 'object' }
}

// ============================================================================
// MCP Server Factory
// ============================================================================

/**
 * Create an MCP server instance.
 *
 * @param {object} options
 * @param {string} options.name - Server name (shown to clients)
 * @param {string} options.version - Server version
 * @param {string} [options.protocolVersion='2024-11-05'] - MCP protocol version
 * @returns {MCPServer}
 */
export function createMCPServer(options = {}) {
  const {
    name = 'mcp-server',
    version = '1.0.0',
    protocolVersion = '2025-11-25'
  } = options

  const tools = new Map()
  const resources = new Map()       // uri -> resource definition
  const resourceTemplates = new Map() // uriTemplate -> template definition
  const subscriptions = new Map()   // uri -> Set of subscriber IDs
  let onActivity = () => {} // Activity callback (set by transport)
  let onNotification = () => {} // Notification callback (set by transport)
  let onClientNotification = null // Optional callback for client notifications

  // ========== TOOLS ==========

  /**
   * Register a tool.
   *
   * @param {object} tool
   * @param {string} tool.name - Tool name (unique identifier)
   * @param {string} tool.description - Human-readable description
   * @param {z.ZodSchema} tool.parameters - Zod schema for parameters
   * @param {function} tool.execute - Async function (params) => result (string or content array)
   * @param {object} [tool.annotations] - Optional tool annotations (ToolAnnotations)
   * @param {string} [tool.annotations.title] - Human-readable title
   * @param {boolean} [tool.annotations.readOnlyHint] - If true, tool doesn't modify environment (default: false)
   * @param {boolean} [tool.annotations.destructiveHint] - If true, tool may destroy data (default: true)
   * @param {boolean} [tool.annotations.idempotentHint] - If true, repeated calls have no extra effect (default: false)
   * @param {boolean} [tool.annotations.openWorldHint] - If true, interacts with external systems (default: true)
   */
  function addTool(tool) {
    if (!tool.name || !tool.execute) {
      throw new Error('Tool must have name and execute function')
    }
    tools.set(tool.name, {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || z.object({}),
      execute: tool.execute,
      annotations: tool.annotations || null
    })
  }

  /**
   * Register multiple tools at once.
   */
  function addTools(toolArray) {
    for (const tool of toolArray) {
      addTool(tool)
    }
  }

  // ========== RESOURCES ==========

  /**
   * Add a resource.
   *
   * @param {object} resource
   * @param {string} resource.uri - Unique resource URI (e.g., 'file:///path', 'myapp://data')
   * @param {string} resource.name - Human-readable name
   * @param {string} [resource.title] - Optional human-readable title for display
   * @param {string} [resource.description] - Optional description
   * @param {string} [resource.mimeType] - Content type (default: text/plain)
   * @param {string} [resource.text] - Static text content
   * @param {function} [resource.read] - Dynamic content: async () => string or { text, annotations }
   * @param {object} [resource.annotations] - Optional resource annotations (Annotations)
   * @param {string[]} [resource.annotations.audience] - Who content is for: ["user"], ["assistant"], or both
   * @param {number} [resource.annotations.priority] - Importance: 0.0 (optional) to 1.0 (required)
   * @param {string} [resource.annotations.lastModified] - ISO 8601 timestamp
   */
  function addResource(resource) {
    if (!resource.uri || !resource.name) {
      throw new Error('Resource must have uri and name')
    }
    if (!resource.text && !resource.read) {
      throw new Error('Resource must have either text or read function')
    }
    resources.set(resource.uri, {
      uri: resource.uri,
      name: resource.name,
      title: resource.title,
      description: resource.description,
      mimeType: resource.mimeType || 'text/plain',
      text: resource.text,
      read: resource.read,
      annotations: resource.annotations || null
    })
  }

  /**
   * Add multiple resources at once.
   */
  function addResources(resourceArray) {
    for (const resource of resourceArray) {
      addResource(resource)
    }
  }

  /**
   * Add a resource template (URI pattern with parameters).
   *
   * @param {object} template
   * @param {string} template.uriTemplate - URI pattern (e.g., 'user://{id}', 'file://{path}')
   * @param {string} template.name - Human-readable name
   * @param {string} [template.title] - Optional human-readable title for display
   * @param {string} [template.description] - Optional description
   * @param {string} [template.mimeType] - Content type
   * @param {function} template.read - async (params) => string or { text, annotations }
   * @param {object} [template.annotations] - Optional annotations for the template itself
   */
  function addResourceTemplate(template) {
    if (!template.uriTemplate || !template.name || !template.read) {
      throw new Error('Resource template must have uriTemplate, name, and read function')
    }
    resourceTemplates.set(template.uriTemplate, {
      uriTemplate: template.uriTemplate,
      name: template.name,
      title: template.title,
      description: template.description,
      mimeType: template.mimeType || 'text/plain',
      read: template.read,
      annotations: template.annotations || null
    })
  }

  // ========== RFC 6570 URI TEMPLATE SUPPORT ==========

  /**
   * Parse RFC 6570 URI template expression.
   * Returns { operator, variables } where variables is [{ name, explode, prefix }]
   *
   * Operators:
   *   (none) - Simple expansion: {var}
   *   +      - Reserved expansion: {+var} (no encoding of reserved chars)
   *   #      - Fragment expansion: {#var}
   *   .      - Label expansion: {.var}
   *   /      - Path segment: {/var}
   *   ;      - Path-style params: {;var}
   *   ?      - Query expansion: {?var}
   *   &      - Query continuation: {&var}
   *
   * Modifiers:
   *   *      - Explode: {var*} (expand arrays/objects)
   *   :n     - Prefix: {var:3} (first n chars)
   */
  function parseExpression(expr) {
    const operators = ['+', '#', '.', '/', ';', '?', '&']
    let operator = ''
    let varList = expr

    if (operators.includes(expr[0])) {
      operator = expr[0]
      varList = expr.slice(1)
    }

    const variables = varList.split(',').map(v => {
      const explode = v.endsWith('*')
      const prefixMatch = v.match(/:(\d+)$/)
      const prefix = prefixMatch ? parseInt(prefixMatch[1], 10) : null
      const name = v.replace(/\*$/, '').replace(/:\d+$/, '')
      return { name, explode, prefix }
    })

    return { operator, variables }
  }

  /**
   * Build regex pattern and capture info for a URI template.
   * Returns { regex, captures } where captures is [{ name, operator, explode }]
   */
  function buildTemplateRegex(uriTemplate) {
    const captures = []
    let pattern = ''
    let lastIndex = 0

    // Match all expressions: {expr}
    const exprRegex = /\{([^}]+)\}/g
    let match

    while ((match = exprRegex.exec(uriTemplate)) !== null) {
      // Add literal text before this expression
      const literal = uriTemplate.slice(lastIndex, match.index)
      pattern += literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

      const { operator, variables } = parseExpression(match[1])

      for (let i = 0; i < variables.length; i++) {
        const { name, explode } = variables[i]
        captures.push({ name, operator, explode })

        // Add separator between variables in same expression
        if (i > 0) {
          const sep = getSeparator(operator)
          pattern += sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        }

        // Add prefix for operators that have one
        if (i === 0) {
          const prefix = getPrefix(operator)
          if (prefix) pattern += prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        }

        // Add capture group based on operator
        pattern += getCapturePattern(operator, explode)
      }

      lastIndex = match.index + match[0].length
    }

    // Add remaining literal text
    pattern += uriTemplate.slice(lastIndex).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    return { regex: new RegExp(`^${pattern}$`), captures }
  }

  /**
   * Get separator for multi-value expressions.
   */
  function getSeparator(operator) {
    switch (operator) {
      case '+': case '': return ','
      case '#': return ','
      case '.': return '.'
      case '/': return '/'
      case ';': return ';'
      case '?': case '&': return '&'
      default: return ','
    }
  }

  /**
   * Get prefix for operator.
   */
  function getPrefix(operator) {
    switch (operator) {
      case '#': return '#'
      case '.': return '.'
      case '/': return '/'
      case ';': return ';'
      case '?': return '?'
      case '&': return '&'
      default: return ''
    }
  }

  /**
   * Get capture pattern for operator.
   */
  function getCapturePattern(operator, explode) {
    switch (operator) {
      case '+':  // Reserved - allow more chars including /
        return explode ? '(.+)' : '([^,]+)'
      case '#':  // Fragment
        return '([^,]*)'
      case '/':  // Path segment
        return explode ? '(.+)' : '([^/]+)'
      case '.':  // Label
        return '([^./]+)'
      case ';':  // Path-style params (name=value)
        return explode ? '([^;]*)' : '([^;,]*)'
      case '?': case '&':  // Query
        return explode ? '([^&]*)' : '([^&,]*)'
      default:   // Simple
        return explode ? '(.+)' : '([^/,]+)'
    }
  }

  /**
   * Decode captured value based on operator.
   */
  function decodeCapture(value, operator, name) {
    if (!value) return value

    // For query/path-style params, strip name= prefix if present
    if ((operator === ';' || operator === '?' || operator === '&') && value.includes('=')) {
      const eqIndex = value.indexOf('=')
      value = value.slice(eqIndex + 1)
    }

    return decodeURIComponent(value)
  }

  /**
   * Match a URI against templates and extract parameters.
   * Supports RFC 6570 URI Templates:
   *   - Level 1: {var}
   *   - Level 2: {+var} (reserved), {#var} (fragment)
   *   - Level 3: {var*} (explode), {/var}, {.var}, {;var}, {?var}, {&var}
   *
   * Returns { template, params } or null if no match.
   */
  function matchTemplate(uri) {
    for (const [uriTemplate, template] of resourceTemplates) {
      const { regex, captures } = buildTemplateRegex(uriTemplate)

      const match = uri.match(regex)
      if (match) {
        const params = {}
        captures.forEach((capture, i) => {
          const value = match[i + 1]
          if (capture.explode && value) {
            // Exploded values: could be array or path segments
            const sep = getSeparator(capture.operator)
            params[capture.name] = value.split(sep).map(v =>
              decodeCapture(v, capture.operator, capture.name)
            )
          } else {
            params[capture.name] = decodeCapture(value, capture.operator, capture.name)
          }
        })
        return { template, params }
      }
    }
    return null
  }

  /**
   * Read a resource by URI.
   * Returns { uri, mimeType, text, annotations? }
   */
  async function readResource(uri) {
    // Check static/dynamic resources first
    const resource = resources.get(uri)
    if (resource) {
      const rawContent = resource.read
        ? await resource.read()
        : resource.text

      // Handle different return formats from read():
      // 1. String - plain text content
      // 2. Object with text and optional annotations
      let text, contentAnnotations
      if (rawContent && typeof rawContent === 'object' && 'text' in rawContent) {
        text = rawContent.text
        contentAnnotations = rawContent.annotations
      } else {
        text = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)
      }

      // Merge annotations: content-level annotations override resource-level
      const annotations = contentAnnotations || resource.annotations || null

      return {
        uri,
        mimeType: resource.mimeType,
        text,
        ...(annotations && { annotations })
      }
    }

    // Try template matching
    const match = matchTemplate(uri)
    if (match) {
      const rawContent = await match.template.read(match.params)

      let text, contentAnnotations
      if (rawContent && typeof rawContent === 'object' && 'text' in rawContent) {
        text = rawContent.text
        contentAnnotations = rawContent.annotations
      } else {
        text = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)
      }

      const annotations = contentAnnotations || match.template.annotations || null

      return {
        uri,
        mimeType: match.template.mimeType,
        text,
        ...(annotations && { annotations })
      }
    }

    throw new MCPError(ErrorCode.RESOURCE_NOT_FOUND, `Resource not found: ${uri}`)
  }

  // ========== NOTIFICATIONS ==========

  /**
   * Set the notification callback. Transport layer uses this to push to clients.
   * @param {function} callback - (method, params, targets) => void
   *   - targets: null = broadcast to all, Set<string> = send only to these client IDs
   */
  function setNotificationCallback(callback) {
    onNotification = callback
  }

  /**
   * Set callback for client-to-server notifications.
   * Apps can use this to react to client events like cancellation or roots changes.
   *
   * @param {function} callback - (method, params) => void
   *   - method: Notification method (e.g., 'notifications/cancelled')
   *   - params: Notification parameters
   *
   * @example
   * mcp.setClientNotificationCallback((method, params) => {
   *   if (method === 'notifications/cancelled') {
   *     abortOperation(params.requestId)
   *   }
   * })
   */
  function setClientNotificationCallback(callback) {
    onClientNotification = callback
  }

  /**
   * Send a notification (broadcast to all clients).
   * @param {string} method - Notification method
   * @param {object} params - Notification parameters
   */
  function notify(method, params = {}) {
    onNotification(method, params, null) // null = broadcast
  }

  /**
   * Send a notification to specific clients only.
   * @param {string} method - Notification method
   * @param {object} params - Notification parameters
   * @param {Set<string>} targets - Client IDs to notify
   */
  function notifyTargeted(method, params, targets) {
    if (targets && targets.size > 0) {
      onNotification(method, params, targets)
    }
  }

  /**
   * Notify that a resource has been updated.
   * Only notifies clients subscribed to this URI.
   * @param {string} uri - The resource URI that changed
   */
  function notifyResourceUpdated(uri) {
    const subscribers = getSubscribers(uri)
    if (subscribers.size > 0) {
      notifyTargeted('notifications/resources/updated', { uri }, subscribers)
    }
  }

  /**
   * Notify that the resource list has changed (broadcast to all).
   */
  function notifyResourceListChanged() {
    notify('notifications/resources/list_changed', {})
  }

  /**
   * Notify that the tool list has changed (broadcast to all).
   */
  function notifyToolListChanged() {
    notify('notifications/tools/list_changed', {})
  }

  /**
   * Send a progress notification for long-running operations.
   * @param {string} progressToken - Token identifying the operation
   * @param {number} progress - Progress value (0-100 or custom range)
   * @param {number} [total] - Total value (optional)
   * @param {string} [clientId] - Specific client to notify (null = broadcast)
   */
  function notifyProgress(progressToken, progress, total, clientId) {
    const params = {
      progressToken,
      progress,
      ...(total !== undefined && { total })
    }
    if (clientId) {
      notifyTargeted('notifications/progress', params, new Set([clientId]))
    } else {
      notify('notifications/progress', params)
    }
  }

  /**
   * Subscribe a client to resource updates.
   * @param {string} uri - Resource URI to subscribe to
   * @param {string} subscriberId - Unique subscriber identifier
   */
  function subscribe(uri, subscriberId) {
    if (!subscriptions.has(uri)) {
      subscriptions.set(uri, new Set())
    }
    subscriptions.get(uri).add(subscriberId)
  }

  /**
   * Unsubscribe a client from resource updates.
   * @param {string} uri - Resource URI
   * @param {string} subscriberId - Subscriber identifier
   */
  function unsubscribe(uri, subscriberId) {
    const subs = subscriptions.get(uri)
    if (subs) {
      subs.delete(subscriberId)
      if (subs.size === 0) {
        subscriptions.delete(uri)
      }
    }
  }

  /**
   * Get all subscribers for a resource.
   * @param {string} uri - Resource URI
   * @returns {Set<string>} Set of subscriber IDs
   */
  function getSubscribers(uri) {
    return subscriptions.get(uri) || new Set()
  }

  // ========== ACTIVITY TRACKING ==========

  /**
   * Set the activity callback for logging/monitoring.
   */
  function setActivityCallback(callback) {
    onActivity = callback
  }

  /**
   * Record activity (called after tool execution).
   */
  function recordActivity(toolName, success, error = null) {
    onActivity({
      tool: toolName,
      timestamp: Date.now(),
      success,
      ...(error && { error })
    })
  }

  // ========== REQUEST HANDLING ==========

  /**
   * Handle MCP JSON-RPC request.
   */
  async function handleRequest(method, params = {}) {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion,
          serverInfo: { name, version },
          capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: true, listChanged: true }
          }
        }

      // ===== TOOLS =====

      case 'tools/list':
        return {
          tools: Array.from(tools.values()).map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: zodToJsonSchema(t.parameters),
            ...(t.annotations && { annotations: t.annotations })
          }))
        }

      case 'tools/call': {
        const { name: toolName, arguments: args } = params
        const tool = tools.get(toolName)

        if (!tool) {
          recordActivity(toolName, false, `Unknown tool: ${toolName}`)
          throw new MCPError(ErrorCode.INVALID_PARAMS, `Unknown tool: ${toolName}`)
        }

        try {
          // Validate parameters with Zod
          const validated = tool.parameters.parse(args || {})
          const result = await tool.execute(validated)

          recordActivity(toolName, true)

          // Handle different result formats:
          // 1. Array of content items (with optional annotations)
          // 2. Object with content array and optional isError
          // 3. Plain string or other value (wrap in text content)
          if (Array.isArray(result)) {
            return { content: result }
          } else if (result && typeof result === 'object' && result.content) {
            // Result object with content array (and possibly isError, structuredContent)
            return result
          } else {
            // Simple result - wrap in text content
            const text = typeof result === 'string' ? result : JSON.stringify(result)
            return { content: [{ type: 'text', text }] }
          }
        } catch (err) {
          recordActivity(toolName, false, err.message)

          // Convert Zod validation errors to INVALID_PARAMS
          if (err.name === 'ZodError') {
            const message = err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
            throw new MCPError(ErrorCode.INVALID_PARAMS, message, { issues: err.issues })
          }

          // Re-throw MCPError as-is
          if (err instanceof MCPError) {
            throw err
          }

          // Wrap other errors as internal errors
          throw new MCPError(ErrorCode.INTERNAL_ERROR, err.message)
        }
      }

      // ===== RESOURCES =====

      case 'resources/list':
        return {
          resources: Array.from(resources.values()).map(r => ({
            uri: r.uri,
            name: r.name,
            ...(r.title && { title: r.title }),
            ...(r.description && { description: r.description }),
            mimeType: r.mimeType,
            ...(r.annotations && { annotations: r.annotations })
          }))
        }

      case 'resources/templates/list':
        return {
          resourceTemplates: Array.from(resourceTemplates.values()).map(t => ({
            uriTemplate: t.uriTemplate,
            name: t.name,
            ...(t.title && { title: t.title }),
            ...(t.description && { description: t.description }),
            mimeType: t.mimeType,
            ...(t.annotations && { annotations: t.annotations })
          }))
        }

      case 'resources/read': {
        const { uri } = params
        if (!uri) throw new Error('Missing uri parameter')

        const content = await readResource(uri)
        return {
          contents: [content]
        }
      }

      case 'resources/subscribe': {
        const { uri } = params
        if (!uri) throw new Error('Missing uri parameter')
        // subscriberId comes from transport layer (connection ID)
        const subscriberId = params._subscriberId || 'default'
        subscribe(uri, subscriberId)
        return {}
      }

      case 'resources/unsubscribe': {
        const { uri } = params
        if (!uri) throw new Error('Missing uri parameter')
        const subscriberId = params._subscriberId || 'default'
        unsubscribe(uri, subscriberId)
        return {}
      }

      case 'ping':
        return {}

      // ===== CLIENT NOTIFICATIONS =====
      // These are sent from client to server and don't require meaningful responses.
      // Per JSON-RPC 2.0, notifications have no id and expect no response,
      // but we return {} so transports can handle them uniformly.

      case 'notifications/initialized':
        // Client signals initialization is complete.
        if (onClientNotification) onClientNotification(method, params)
        return {}

      case 'notifications/cancelled':
        // Client requests cancellation of a pending request.
        if (onClientNotification) onClientNotification(method, params)
        return {}

      case 'notifications/roots/list_changed':
        // Client's root list has changed.
        if (onClientNotification) onClientNotification(method, params)
        return {}

      default:
        throw new MCPError(ErrorCode.METHOD_NOT_FOUND, `Unknown method: ${method}`)
    }
  }

  return {
    // Configuration
    name,
    version,
    protocolVersion,

    // Tool management
    tools,
    addTool,
    addTools,

    // Resource management
    resources,
    resourceTemplates,
    addResource,
    addResources,
    addResourceTemplate,
    readResource,

    // Subscriptions
    subscriptions,
    subscribe,
    unsubscribe,
    getSubscribers,

    // Notifications (server → client)
    setNotificationCallback,
    notify,
    notifyTargeted,
    notifyResourceUpdated,
    notifyResourceListChanged,
    notifyToolListChanged,
    notifyProgress,

    // Client notifications (client → server)
    setClientNotificationCallback,

    // Activity tracking
    setActivityCallback,
    recordActivity,

    // Request handling
    handleRequest
  }
}

// Re-export zod for convenience
export { z }
