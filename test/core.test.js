import test from 'brittle'
import { createMCPServer, z } from '../index.js'

test('createMCPServer - creates server with defaults', async (t) => {
  const mcp = createMCPServer()

  t.is(mcp.name, 'mcp-server')
  t.is(mcp.version, '1.0.0')
  t.is(mcp.protocolVersion, '2025-11-25')
  t.is(mcp.tools.size, 0)
  t.is(mcp.resources.size, 0)
})

test('createMCPServer - creates server with custom options', async (t) => {
  const mcp = createMCPServer({
    name: 'my-server',
    version: '2.0.0',
    protocolVersion: '2025-01-01'
  })

  t.is(mcp.name, 'my-server')
  t.is(mcp.version, '2.0.0')
  t.is(mcp.protocolVersion, '2025-01-01')
})

test('addTool - registers a tool', async (t) => {
  const mcp = createMCPServer()

  mcp.addTool({
    name: 'greet',
    description: 'Say hello',
    parameters: z.object({ name: z.string() }),
    execute: async ({ name }) => `Hello, ${name}!`
  })

  t.is(mcp.tools.size, 1)
  t.ok(mcp.tools.has('greet'))

  const tool = mcp.tools.get('greet')
  t.is(tool.name, 'greet')
  t.is(tool.description, 'Say hello')
})

test('addTool - throws without name', async (t) => {
  const mcp = createMCPServer()

  try {
    mcp.addTool({ execute: async () => 'test' })
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('name'))
  }
})

test('addTool - throws without execute', async (t) => {
  const mcp = createMCPServer()

  try {
    mcp.addTool({ name: 'test' })
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('execute'))
  }
})

test('addTools - registers multiple tools', async (t) => {
  const mcp = createMCPServer()

  mcp.addTools([
    { name: 'tool1', execute: async () => 'one' },
    { name: 'tool2', execute: async () => 'two' },
    { name: 'tool3', execute: async () => 'three' }
  ])

  t.is(mcp.tools.size, 3)
  t.ok(mcp.tools.has('tool1'))
  t.ok(mcp.tools.has('tool2'))
  t.ok(mcp.tools.has('tool3'))
})

test('addResource - registers static resource', async (t) => {
  const mcp = createMCPServer()

  mcp.addResource({
    uri: 'test://data',
    name: 'Test Data',
    description: 'Some test data',
    mimeType: 'application/json',
    text: '{"foo": "bar"}'
  })

  t.is(mcp.resources.size, 1)
  t.ok(mcp.resources.has('test://data'))

  const resource = mcp.resources.get('test://data')
  t.is(resource.name, 'Test Data')
  t.is(resource.mimeType, 'application/json')
})

test('addResource - registers dynamic resource', async (t) => {
  const mcp = createMCPServer()
  let callCount = 0

  mcp.addResource({
    uri: 'stats://live',
    name: 'Live Stats',
    read: async () => {
      callCount++
      return JSON.stringify({ count: callCount })
    }
  })

  t.is(mcp.resources.size, 1)

  const result1 = await mcp.readResource('stats://live')
  t.is(result1.text, '{"count":1}')

  const result2 = await mcp.readResource('stats://live')
  t.is(result2.text, '{"count":2}')
})

test('addResource - throws without uri', async (t) => {
  const mcp = createMCPServer()

  try {
    mcp.addResource({ name: 'Test', text: 'data' })
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('uri'))
  }
})

test('addResource - throws without text or read', async (t) => {
  const mcp = createMCPServer()

  try {
    mcp.addResource({ uri: 'test://x', name: 'Test' })
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('text'))
  }
})

test('addResourceTemplate - registers URI template', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'user://{id}',
    name: 'User by ID',
    read: async ({ id }) => JSON.stringify({ id, name: `User ${id}` })
  })

  t.is(mcp.resourceTemplates.size, 1)

  const result = await mcp.readResource('user://alice')
  t.is(result.uri, 'user://alice')
  t.is(JSON.parse(result.text).id, 'alice')
})

test('addResourceTemplate - extracts multiple parameters', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'posts://{userId}/{postId}',
    name: 'Post',
    read: async ({ userId, postId }) => JSON.stringify({ userId, postId })
  })

  const result = await mcp.readResource('posts://bob/123')
  const data = JSON.parse(result.text)

  t.is(data.userId, 'bob')
  t.is(data.postId, '123')
})

test('readResource - returns 404 for unknown URI', async (t) => {
  const mcp = createMCPServer()

  try {
    await mcp.readResource('unknown://resource')
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('not found'))
  }
})

test('readResource - prefers exact match over template', async (t) => {
  const mcp = createMCPServer()

  // Add template
  mcp.addResourceTemplate({
    uriTemplate: 'data://{id}',
    name: 'Data by ID',
    read: async ({ id }) => `template:${id}`
  })

  // Add exact resource with same pattern
  mcp.addResource({
    uri: 'data://special',
    name: 'Special Data',
    text: 'exact:special'
  })

  const exact = await mcp.readResource('data://special')
  t.is(exact.text, 'exact:special')

  const templated = await mcp.readResource('data://other')
  t.is(templated.text, 'template:other')
})
