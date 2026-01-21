import test from 'brittle'
import { createMCPServer } from '../index.js'

test('notify - broadcasts to all clients', async (t) => {
  const mcp = createMCPServer()
  const received = []

  mcp.setNotificationCallback((method, params, targets) => {
    received.push({ method, params, targets })
  })

  mcp.notify('custom/event', { data: 'test' })

  t.is(received.length, 1)
  t.is(received[0].method, 'custom/event')
  t.is(received[0].params.data, 'test')
  t.is(received[0].targets, null) // null = broadcast
})

test('notifyTargeted - sends to specific clients', async (t) => {
  const mcp = createMCPServer()
  const received = []

  mcp.setNotificationCallback((method, params, targets) => {
    received.push({ method, params, targets })
  })

  const targets = new Set(['client-1', 'client-2'])
  mcp.notifyTargeted('targeted/event', { foo: 'bar' }, targets)

  t.is(received.length, 1)
  t.ok(received[0].targets.has('client-1'))
  t.ok(received[0].targets.has('client-2'))
  t.is(received[0].targets.size, 2)
})

test('notifyTargeted - does not send if no targets', async (t) => {
  const mcp = createMCPServer()
  const received = []

  mcp.setNotificationCallback((method, params, targets) => {
    received.push({ method, params, targets })
  })

  mcp.notifyTargeted('targeted/event', {}, new Set())

  t.is(received.length, 0)
})

test('notifyResourceUpdated - only notifies subscribers', async (t) => {
  const mcp = createMCPServer()
  const received = []

  mcp.setNotificationCallback((method, params, targets) => {
    received.push({ method, params, targets })
  })

  // Subscribe two clients to different resources
  mcp.subscribe('data://a', 'client-1')
  mcp.subscribe('data://a', 'client-2')
  mcp.subscribe('data://b', 'client-3')

  // Notify resource A
  mcp.notifyResourceUpdated('data://a')

  t.is(received.length, 1)
  t.is(received[0].method, 'notifications/resources/updated')
  t.is(received[0].params.uri, 'data://a')
  t.ok(received[0].targets.has('client-1'))
  t.ok(received[0].targets.has('client-2'))
  t.not(received[0].targets.has('client-3'))
})

test('notifyResourceUpdated - does nothing if no subscribers', async (t) => {
  const mcp = createMCPServer()
  const received = []

  mcp.setNotificationCallback((method, params, targets) => {
    received.push({ method, params, targets })
  })

  mcp.notifyResourceUpdated('data://nobody-subscribed')

  t.is(received.length, 0)
})

test('notifyResourceListChanged - broadcasts to all', async (t) => {
  const mcp = createMCPServer()
  const received = []

  mcp.setNotificationCallback((method, params, targets) => {
    received.push({ method, params, targets })
  })

  mcp.notifyResourceListChanged()

  t.is(received.length, 1)
  t.is(received[0].method, 'notifications/resources/list_changed')
  t.is(received[0].targets, null)
})

test('notifyToolListChanged - broadcasts to all', async (t) => {
  const mcp = createMCPServer()
  const received = []

  mcp.setNotificationCallback((method, params, targets) => {
    received.push({ method, params, targets })
  })

  mcp.notifyToolListChanged()

  t.is(received.length, 1)
  t.is(received[0].method, 'notifications/tools/list_changed')
  t.is(received[0].targets, null)
})

test('notifyProgress - broadcasts by default', async (t) => {
  const mcp = createMCPServer()
  const received = []

  mcp.setNotificationCallback((method, params, targets) => {
    received.push({ method, params, targets })
  })

  mcp.notifyProgress('upload-123', 50, 100)

  t.is(received.length, 1)
  t.is(received[0].method, 'notifications/progress')
  t.is(received[0].params.progressToken, 'upload-123')
  t.is(received[0].params.progress, 50)
  t.is(received[0].params.total, 100)
  t.is(received[0].targets, null)
})

test('notifyProgress - targets specific client', async (t) => {
  const mcp = createMCPServer()
  const received = []

  mcp.setNotificationCallback((method, params, targets) => {
    received.push({ method, params, targets })
  })

  mcp.notifyProgress('download-456', 75, 100, 'client-5')

  t.is(received.length, 1)
  t.ok(received[0].targets.has('client-5'))
  t.is(received[0].targets.size, 1)
})

test('subscribe/unsubscribe - manages subscriptions', async (t) => {
  const mcp = createMCPServer()

  // Initial state
  t.is(mcp.getSubscribers('data://x').size, 0)

  // Subscribe
  mcp.subscribe('data://x', 'client-1')
  mcp.subscribe('data://x', 'client-2')
  t.is(mcp.getSubscribers('data://x').size, 2)

  // Unsubscribe one
  mcp.unsubscribe('data://x', 'client-1')
  t.is(mcp.getSubscribers('data://x').size, 1)
  t.ok(mcp.getSubscribers('data://x').has('client-2'))

  // Unsubscribe last - should clean up
  mcp.unsubscribe('data://x', 'client-2')
  t.is(mcp.getSubscribers('data://x').size, 0)
})

test('subscribe - same client multiple times is idempotent', async (t) => {
  const mcp = createMCPServer()

  mcp.subscribe('data://x', 'client-1')
  mcp.subscribe('data://x', 'client-1')
  mcp.subscribe('data://x', 'client-1')

  t.is(mcp.getSubscribers('data://x').size, 1)
})

test('unsubscribe - non-existent subscription is safe', async (t) => {
  const mcp = createMCPServer()

  // Should not throw
  mcp.unsubscribe('data://nonexistent', 'client-1')
  t.pass()
})

test('activity callback - records tool calls', async (t) => {
  const mcp = createMCPServer()
  const activities = []

  mcp.setActivityCallback((entry) => {
    activities.push(entry)
  })

  mcp.addTool({
    name: 'test',
    execute: async () => 'ok'
  })

  await mcp.handleRequest('tools/call', { name: 'test' })

  t.is(activities.length, 1)
  t.is(activities[0].tool, 'test')
  t.is(activities[0].success, true)
  t.ok(activities[0].timestamp)
})

test('activity callback - records failed tool calls', async (t) => {
  const mcp = createMCPServer()
  const activities = []

  mcp.setActivityCallback((entry) => {
    activities.push(entry)
  })

  mcp.addTool({
    name: 'fail',
    execute: async () => { throw new Error('Intentional failure') }
  })

  try {
    await mcp.handleRequest('tools/call', { name: 'fail' })
  } catch {
    // Expected
  }

  t.is(activities.length, 1)
  t.is(activities[0].tool, 'fail')
  t.is(activities[0].success, false)
  t.ok(activities[0].error.includes('Intentional failure'))
})
