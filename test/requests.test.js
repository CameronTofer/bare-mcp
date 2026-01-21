import test from 'brittle'
import { createMCPServer, z } from '../index.js'

test('handleRequest - initialize returns server info', async (t) => {
  const mcp = createMCPServer({ name: 'test-server', version: '1.2.3' })

  const result = await mcp.handleRequest('initialize', {})

  t.is(result.protocolVersion, '2024-11-05')
  t.is(result.serverInfo.name, 'test-server')
  t.is(result.serverInfo.version, '1.2.3')
  t.ok(result.capabilities.tools)
  t.ok(result.capabilities.resources)
})

test('handleRequest - tools/list returns registered tools', async (t) => {
  const mcp = createMCPServer()

  mcp.addTool({
    name: 'echo',
    description: 'Echo a message',
    parameters: z.object({ msg: z.string() }),
    execute: async ({ msg }) => msg
  })

  const result = await mcp.handleRequest('tools/list', {})

  t.is(result.tools.length, 1)
  t.is(result.tools[0].name, 'echo')
  t.is(result.tools[0].description, 'Echo a message')
  t.ok(result.tools[0].inputSchema)
  t.is(result.tools[0].inputSchema.type, 'object')
})

test('handleRequest - tools/call executes tool', async (t) => {
  const mcp = createMCPServer()

  mcp.addTool({
    name: 'add',
    parameters: z.object({ a: z.number(), b: z.number() }),
    execute: async ({ a, b }) => JSON.stringify({ sum: a + b })
  })

  const result = await mcp.handleRequest('tools/call', {
    name: 'add',
    arguments: { a: 2, b: 3 }
  })

  t.is(result.content.length, 1)
  t.is(result.content[0].type, 'text')
  t.is(JSON.parse(result.content[0].text).sum, 5)
})

test('handleRequest - tools/call validates parameters', async (t) => {
  const mcp = createMCPServer()

  mcp.addTool({
    name: 'greet',
    parameters: z.object({ name: z.string() }),
    execute: async ({ name }) => `Hello, ${name}`
  })

  try {
    await mcp.handleRequest('tools/call', {
      name: 'greet',
      arguments: { name: 123 } // Should be string
    })
    t.fail('Should have thrown validation error')
  } catch (err) {
    t.ok(err.message || err.issues)
  }
})

test('handleRequest - tools/call throws for unknown tool', async (t) => {
  const mcp = createMCPServer()

  try {
    await mcp.handleRequest('tools/call', { name: 'nonexistent' })
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('Unknown tool'))
  }
})

test('handleRequest - resources/list returns resources', async (t) => {
  const mcp = createMCPServer()

  mcp.addResource({
    uri: 'config://app',
    name: 'App Config',
    description: 'Configuration',
    mimeType: 'application/json',
    text: '{}'
  })

  const result = await mcp.handleRequest('resources/list', {})

  t.is(result.resources.length, 1)
  t.is(result.resources[0].uri, 'config://app')
  t.is(result.resources[0].name, 'App Config')
})

test('handleRequest - resources/templates/list returns templates', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'user://{id}',
    name: 'User',
    description: 'Get user by ID',
    read: async () => '{}'
  })

  const result = await mcp.handleRequest('resources/templates/list', {})

  t.is(result.resourceTemplates.length, 1)
  t.is(result.resourceTemplates[0].uriTemplate, 'user://{id}')
})

test('handleRequest - resources/read reads static resource', async (t) => {
  const mcp = createMCPServer()

  mcp.addResource({
    uri: 'data://test',
    name: 'Test',
    text: 'Hello, World!'
  })

  const result = await mcp.handleRequest('resources/read', { uri: 'data://test' })

  t.is(result.contents.length, 1)
  t.is(result.contents[0].uri, 'data://test')
  t.is(result.contents[0].text, 'Hello, World!')
})

test('handleRequest - resources/read reads templated resource', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'item://{id}',
    name: 'Item',
    read: async ({ id }) => JSON.stringify({ id })
  })

  const result = await mcp.handleRequest('resources/read', { uri: 'item://42' })

  t.is(result.contents[0].uri, 'item://42')
  t.is(JSON.parse(result.contents[0].text).id, '42')
})

test('handleRequest - resources/subscribe tracks subscription', async (t) => {
  const mcp = createMCPServer()

  await mcp.handleRequest('resources/subscribe', {
    uri: 'data://test',
    _subscriberId: 'client-1'
  })

  const subscribers = mcp.getSubscribers('data://test')
  t.ok(subscribers.has('client-1'))
})

test('handleRequest - resources/unsubscribe removes subscription', async (t) => {
  const mcp = createMCPServer()

  // Subscribe first
  mcp.subscribe('data://test', 'client-1')
  t.ok(mcp.getSubscribers('data://test').has('client-1'))

  // Unsubscribe
  await mcp.handleRequest('resources/unsubscribe', {
    uri: 'data://test',
    _subscriberId: 'client-1'
  })

  t.is(mcp.getSubscribers('data://test').size, 0)
})

test('handleRequest - ping returns empty object', async (t) => {
  const mcp = createMCPServer()

  const result = await mcp.handleRequest('ping', {})

  t.alike(result, {})
})

test('handleRequest - unknown method throws', async (t) => {
  const mcp = createMCPServer()

  try {
    await mcp.handleRequest('unknown/method', {})
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('Unknown method'))
  }
})
