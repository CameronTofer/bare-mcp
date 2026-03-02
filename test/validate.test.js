import test from 'brittle'
import { validateArgs, validateOutput, ErrorCode, MCPError, createMCPServer } from '../index.js'

test('validateArgs - no schema returns args unchanged', async (t) => {
  const args = { foo: 'bar' }
  t.alike(validateArgs(null, args), args)
  t.alike(validateArgs({}, args), args)
  t.alike(validateArgs({ type: 'object' }, args), args)
})

test('validateArgs - applies defaults for undefined args', async (t) => {
  const schema = {
    properties: {
      color: { type: 'string', default: 'blue' },
      count: { type: 'number', default: 10 }
    }
  }
  const result = validateArgs(schema, {})
  t.is(result.color, 'blue')
  t.is(result.count, 10)
})

test('validateArgs - does not overwrite provided args with defaults', async (t) => {
  const schema = {
    properties: {
      color: { type: 'string', default: 'blue' }
    }
  }
  const result = validateArgs(schema, { color: 'red' })
  t.is(result.color, 'red')
})

test('validateArgs - required field missing throws INVALID_PARAMS', async (t) => {
  const schema = {
    properties: { name: { type: 'string' } },
    required: ['name']
  }
  try {
    validateArgs(schema, {})
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err instanceof MCPError)
    t.is(err.code, ErrorCode.INVALID_PARAMS)
    t.ok(err.message.includes('name'))
    t.ok(err.message.includes('required'))
  }
})

test('validateArgs - wrong type throws', async (t) => {
  const schema = {
    properties: { count: { type: 'number' } }
  }
  try {
    validateArgs(schema, { count: 'not-a-number' })
    t.fail('Should have thrown')
  } catch (err) {
    t.is(err.code, ErrorCode.INVALID_PARAMS)
    t.ok(err.message.includes('count'))
    t.ok(err.message.includes('number'))
  }
})

test('validateArgs - integer type rejects float', async (t) => {
  const schema = {
    properties: { n: { type: 'integer' } }
  }
  try {
    validateArgs(schema, { n: 3.5 })
    t.fail('Should have thrown')
  } catch (err) {
    t.is(err.code, ErrorCode.INVALID_PARAMS)
    t.ok(err.message.includes('integer'))
  }
})

test('validateArgs - integer type accepts whole number', async (t) => {
  const schema = {
    properties: { n: { type: 'integer' } }
  }
  const result = validateArgs(schema, { n: 5 })
  t.is(result.n, 5)
})

test('validateArgs - string too short throws', async (t) => {
  const schema = {
    properties: { text: { type: 'string', minLength: 16 } }
  }
  try {
    validateArgs(schema, { text: 'short' })
    t.fail('Should have thrown')
  } catch (err) {
    t.is(err.code, ErrorCode.INVALID_PARAMS)
    t.ok(err.message.includes('text'))
    t.ok(err.message.includes('at least 16'))
  }
})

test('validateArgs - string too long throws', async (t) => {
  const schema = {
    properties: { text: { type: 'string', maxLength: 10 } }
  }
  try {
    validateArgs(schema, { text: 'this is way too long' })
    t.fail('Should have thrown')
  } catch (err) {
    t.is(err.code, ErrorCode.INVALID_PARAMS)
    t.ok(err.message.includes('text'))
    t.ok(err.message.includes('at most 10'))
  }
})

test('validateArgs - string at exact bounds passes', async (t) => {
  const schema = {
    properties: { text: { type: 'string', minLength: 3, maxLength: 5 } }
  }
  t.is(validateArgs(schema, { text: 'abc' }).text, 'abc')
  t.is(validateArgs(schema, { text: 'abcde' }).text, 'abcde')
})

test('validateArgs - number below minimum throws', async (t) => {
  const schema = {
    properties: { n: { type: 'number', minimum: 1 } }
  }
  try {
    validateArgs(schema, { n: 0 })
    t.fail('Should have thrown')
  } catch (err) {
    t.is(err.code, ErrorCode.INVALID_PARAMS)
    t.ok(err.message.includes('n'))
    t.ok(err.message.includes('>= 1'))
  }
})

test('validateArgs - number above maximum throws', async (t) => {
  const schema = {
    properties: { n: { type: 'number', maximum: 100 } }
  }
  try {
    validateArgs(schema, { n: 101 })
    t.fail('Should have thrown')
  } catch (err) {
    t.is(err.code, ErrorCode.INVALID_PARAMS)
    t.ok(err.message.includes('n'))
    t.ok(err.message.includes('<= 100'))
  }
})

test('validateArgs - number at bounds passes', async (t) => {
  const schema = {
    properties: { n: { type: 'number', minimum: 0, maximum: 10 } }
  }
  t.is(validateArgs(schema, { n: 0 }).n, 0)
  t.is(validateArgs(schema, { n: 10 }).n, 10)
})

test('validateArgs - enum value not in list throws', async (t) => {
  const schema = {
    properties: { stance: { type: 'string', enum: ['accept', 'reject'] } }
  }
  try {
    validateArgs(schema, { stance: 'maybe' })
    t.fail('Should have thrown')
  } catch (err) {
    t.is(err.code, ErrorCode.INVALID_PARAMS)
    t.ok(err.message.includes('stance'))
    t.ok(err.message.includes('accept'))
  }
})

test('validateArgs - valid enum passes', async (t) => {
  const schema = {
    properties: { stance: { type: 'string', enum: ['accept', 'reject'] } }
  }
  t.is(validateArgs(schema, { stance: 'accept' }).stance, 'accept')
})

test('validateArgs - pattern mismatch throws', async (t) => {
  const schema = {
    properties: { id: { type: 'string', pattern: '^[a-f0-9]+$' } }
  }
  try {
    validateArgs(schema, { id: 'xyz!' })
    t.fail('Should have thrown')
  } catch (err) {
    t.is(err.code, ErrorCode.INVALID_PARAMS)
    t.ok(err.message.includes('id'))
    t.ok(err.message.includes('pattern'))
  }
})

test('validateArgs - pattern match passes', async (t) => {
  const schema = {
    properties: { id: { type: 'string', pattern: '^[a-f0-9]+$' } }
  }
  t.is(validateArgs(schema, { id: 'abc123' }).id, 'abc123')
})

test('validateArgs - array with wrong item type throws', async (t) => {
  const schema = {
    properties: { tags: { type: 'array', items: { type: 'string' } } }
  }
  try {
    validateArgs(schema, { tags: ['ok', 42] })
    t.fail('Should have thrown')
  } catch (err) {
    t.is(err.code, ErrorCode.INVALID_PARAMS)
    t.ok(err.message.includes('tags[1]'))
    t.ok(err.message.includes('string'))
  }
})

test('validateArgs - valid array passes', async (t) => {
  const schema = {
    properties: { tags: { type: 'array', items: { type: 'string' } } }
  }
  const result = validateArgs(schema, { tags: ['a', 'b'] })
  t.alike(result.tags, ['a', 'b'])
})

test('validateArgs - type array is checked', async (t) => {
  const schema = {
    properties: { items: { type: 'array' } }
  }
  try {
    validateArgs(schema, { items: 'not-array' })
    t.fail('Should have thrown')
  } catch (err) {
    t.is(err.code, ErrorCode.INVALID_PARAMS)
    t.ok(err.message.includes('items'))
    t.ok(err.message.includes('array'))
  }
})

test('validateArgs - boolean type', async (t) => {
  const schema = {
    properties: { flag: { type: 'boolean' } }
  }
  t.is(validateArgs(schema, { flag: true }).flag, true)
  try {
    validateArgs(schema, { flag: 'yes' })
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('boolean'))
  }
})

test('validateArgs - valid args pass through unchanged', async (t) => {
  const schema = {
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 50 },
      count: { type: 'number', minimum: 0 },
      active: { type: 'boolean' }
    },
    required: ['name']
  }
  const args = { name: 'test', count: 5, active: true }
  const result = validateArgs(schema, args)
  t.alike(result, args)
})

test('integration - tool with schema rejects bad args before execute', async (t) => {
  const mcp = createMCPServer()
  let executeCalled = false

  mcp.addTool({
    name: 'strict',
    description: 'Tool with strict schema',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 5 }
      },
      required: ['text']
    },
    execute: async (args) => {
      executeCalled = true
      return 'ok'
    }
  })

  try {
    await mcp.handleRequest('tools/call', { name: 'strict', arguments: { text: 'hi' } })
    t.fail('Should have thrown')
  } catch (err) {
    t.is(err.code, ErrorCode.INVALID_PARAMS)
    t.ok(err.message.includes('text'))
    t.is(executeCalled, false, 'execute should not have been called')
  }
})

test('integration - tool with schema applies defaults', async (t) => {
  const mcp = createMCPServer()

  mcp.addTool({
    name: 'defaulted',
    description: 'Tool with defaults',
    inputSchema: {
      type: 'object',
      properties: {
        k: { type: 'number', default: 10 }
      }
    },
    execute: async (args) => JSON.stringify(args)
  })

  const result = await mcp.handleRequest('tools/call', { name: 'defaulted', arguments: {} })
  const parsed = JSON.parse(result.content[0].text)
  t.is(parsed.k, 10)
})

// ============================================================================
// validateOutput Tests
// ============================================================================

test('validateOutput - no schema is a no-op', async (t) => {
  validateOutput(null, { anything: true })
  validateOutput({}, { anything: true })
  validateOutput({ type: 'object' }, { anything: true })
  t.pass()
})

test('validateOutput - valid output passes', async (t) => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      count: { type: 'number' }
    },
    required: ['id']
  }
  validateOutput(schema, { id: 'abc', count: 5 })
  t.pass()
})

test('validateOutput - missing required field throws INTERNAL_ERROR', async (t) => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string' }
    },
    required: ['id']
  }
  try {
    validateOutput(schema, {})
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err instanceof MCPError)
    t.is(err.code, ErrorCode.INTERNAL_ERROR)
    t.ok(err.message.includes('id'))
    t.ok(err.message.includes('required'))
  }
})

test('validateOutput - wrong type throws INTERNAL_ERROR', async (t) => {
  const schema = {
    type: 'object',
    properties: {
      count: { type: 'number' }
    }
  }
  try {
    validateOutput(schema, { count: 'not-a-number' })
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err instanceof MCPError)
    t.is(err.code, ErrorCode.INTERNAL_ERROR)
    t.ok(err.message.includes('count'))
  }
})

test('validateOutput - string pattern violation throws INTERNAL_ERROR', async (t) => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string', pattern: '^[a-f0-9]+$' }
    }
  }
  try {
    validateOutput(schema, { id: 'INVALID!' })
    t.fail('Should have thrown')
  } catch (err) {
    t.is(err.code, ErrorCode.INTERNAL_ERROR)
    t.ok(err.message.includes('pattern'))
  }
})

test('validateOutput - extra properties are ignored', async (t) => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string' }
    },
    required: ['id']
  }
  validateOutput(schema, { id: 'abc', extra: 'stuff', more: 123 })
  t.pass()
})

test('validateOutput - array item type check', async (t) => {
  const schema = {
    type: 'object',
    properties: {
      tags: { type: 'array', items: { type: 'string' } }
    }
  }
  validateOutput(schema, { tags: ['a', 'b'] })

  try {
    validateOutput(schema, { tags: ['a', 42] })
    t.fail('Should have thrown')
  } catch (err) {
    t.is(err.code, ErrorCode.INTERNAL_ERROR)
    t.ok(err.message.includes('tags[1]'))
  }
})

test('integration - tool with outputSchema validates structuredContent', async (t) => {
  const mcp = createMCPServer()

  mcp.addTool({
    name: 'valid-output',
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    },
    execute: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { id: 'abc123' }
    })
  })

  const result = await mcp.handleRequest('tools/call', { name: 'valid-output' })
  t.is(result.structuredContent.id, 'abc123')
})

test('integration - tool with outputSchema rejects bad structuredContent', async (t) => {
  const mcp = createMCPServer()

  mcp.addTool({
    name: 'bad-output',
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    },
    execute: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { wrong: 'field' }
    })
  })

  try {
    await mcp.handleRequest('tools/call', { name: 'bad-output' })
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err instanceof MCPError)
    t.is(err.code, ErrorCode.INTERNAL_ERROR)
    t.ok(err.message.includes('id'))
  }
})

test('integration - tool without outputSchema skips validation', async (t) => {
  const mcp = createMCPServer()

  mcp.addTool({
    name: 'no-schema',
    execute: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { anything: 'goes' }
    })
  })

  const result = await mcp.handleRequest('tools/call', { name: 'no-schema' })
  t.is(result.structuredContent.anything, 'goes')
})

test('integration - tool with outputSchema but no structuredContent skips validation', async (t) => {
  const mcp = createMCPServer()

  mcp.addTool({
    name: 'text-only',
    outputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    },
    execute: async () => ({
      content: [{ type: 'text', text: 'no structured data' }]
    })
  })

  const result = await mcp.handleRequest('tools/call', { name: 'text-only' })
  t.is(result.content[0].text, 'no structured data')
})
