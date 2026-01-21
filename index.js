/**
 * General-Purpose MCP Server Library
 *
 * A minimal, reusable implementation of the Model Context Protocol (MCP).
 * Works with any project — just register your tools/resources and pick a transport.
 *
 * Usage:
 *   import { createMCPServer } from './mcp/index.js'
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
 *   // Then use with a transport:
 *   import { createHttpTransport } from './mcp/http.js'
 *   await createHttpTransport(mcp, { port: 3000 })
 */

import { z } from 'zod'

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
    protocolVersion = '2024-11-05'
  } = options

  const tools = new Map()
  const resources = new Map()       // uri -> resource definition
  const resourceTemplates = new Map() // uriTemplate -> template definition
  const subscriptions = new Map()   // uri -> Set of subscriber IDs
  let onActivity = () => {} // Activity callback (set by transport)
  let onNotification = () => {} // Notification callback (set by transport)

  // ========== TOOLS ==========

  /**
   * Register a tool.
   *
   * @param {object} tool
   * @param {string} tool.name - Tool name (unique identifier)
   * @param {string} tool.description - Human-readable description
   * @param {z.ZodSchema} tool.parameters - Zod schema for parameters
   * @param {function} tool.execute - Async function (params) => string result
   */
  function addTool(tool) {
    if (!tool.name || !tool.execute) {
      throw new Error('Tool must have name and execute function')
    }
    tools.set(tool.name, {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || z.object({}),
      execute: tool.execute
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
   * @param {string} [resource.description] - Optional description
   * @param {string} [resource.mimeType] - Content type (default: text/plain)
   * @param {string} [resource.text] - Static text content
   * @param {function} [resource.read] - Dynamic content: async () => string
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
      description: resource.description,
      mimeType: resource.mimeType || 'text/plain',
      text: resource.text,
      read: resource.read
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
   * @param {string} [template.description] - Optional description
   * @param {string} [template.mimeType] - Content type
   * @param {function} template.read - async (params) => string, params extracted from URI
   */
  function addResourceTemplate(template) {
    if (!template.uriTemplate || !template.name || !template.read) {
      throw new Error('Resource template must have uriTemplate, name, and read function')
    }
    resourceTemplates.set(template.uriTemplate, {
      uriTemplate: template.uriTemplate,
      name: template.name,
      description: template.description,
      mimeType: template.mimeType || 'text/plain',
      read: template.read
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
   */
  async function readResource(uri) {
    // Check static/dynamic resources first
    const resource = resources.get(uri)
    if (resource) {
      const content = resource.read
        ? await resource.read()
        : resource.text
      return {
        uri,
        mimeType: resource.mimeType,
        text: typeof content === 'string' ? content : JSON.stringify(content)
      }
    }

    // Try template matching
    const match = matchTemplate(uri)
    if (match) {
      const content = await match.template.read(match.params)
      return {
        uri,
        mimeType: match.template.mimeType,
        text: typeof content === 'string' ? content : JSON.stringify(content)
      }
    }

    throw new Error(`Resource not found: ${uri}`)
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
            inputSchema: zodToJsonSchema(t.parameters)
          }))
        }

      case 'tools/call': {
        const { name: toolName, arguments: args } = params
        const tool = tools.get(toolName)

        if (!tool) {
          recordActivity(toolName, false, `Unknown tool: ${toolName}`)
          throw new Error(`Unknown tool: ${toolName}`)
        }

        try {
          // Validate parameters with Zod
          const validated = tool.parameters.parse(args || {})
          const result = await tool.execute(validated)

          recordActivity(toolName, true)

          // Ensure result is a string
          const text = typeof result === 'string' ? result : JSON.stringify(result)
          return { content: [{ type: 'text', text }] }
        } catch (err) {
          recordActivity(toolName, false, err.message)
          throw err
        }
      }

      // ===== RESOURCES =====

      case 'resources/list':
        return {
          resources: Array.from(resources.values()).map(r => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType
          }))
        }

      case 'resources/templates/list':
        return {
          resourceTemplates: Array.from(resourceTemplates.values()).map(t => ({
            uriTemplate: t.uriTemplate,
            name: t.name,
            description: t.description,
            mimeType: t.mimeType
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

      default:
        throw new Error(`Unknown method: ${method}`)
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

    // Notifications
    setNotificationCallback,
    notify,
    notifyTargeted,
    notifyResourceUpdated,
    notifyResourceListChanged,
    notifyToolListChanged,
    notifyProgress,

    // Activity tracking
    setActivityCallback,
    recordActivity,

    // Request handling
    handleRequest
  }
}

// Re-export zod for convenience
export { z }
