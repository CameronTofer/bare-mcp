import test from 'brittle'
import { createMCPServer } from '../index.js'

// RFC 6570 Level 1: Simple expansion

test('RFC 6570 Level 1 - simple variable {var}', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'user://{id}',
    name: 'User',
    read: async ({ id }) => JSON.stringify({ id })
  })

  const result = await mcp.readResource('user://alice')
  t.is(JSON.parse(result.text).id, 'alice')
})

test('RFC 6570 Level 1 - multiple variables {var1}/{var2}', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'posts://{user}/{post}',
    name: 'Post',
    read: async ({ user, post }) => JSON.stringify({ user, post })
  })

  const result = await mcp.readResource('posts://bob/123')
  const data = JSON.parse(result.text)
  t.is(data.user, 'bob')
  t.is(data.post, '123')
})

// RFC 6570 Level 2: Reserved expansion

test('RFC 6570 Level 2 - reserved expansion {+path}', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'file://{+path}',
    name: 'File',
    read: async ({ path }) => JSON.stringify({ path })
  })

  // Reserved expansion allows / in the value
  const result = await mcp.readResource('file://home/user/docs/file.txt')
  t.is(JSON.parse(result.text).path, 'home/user/docs/file.txt')
})

test('RFC 6570 Level 2 - fragment expansion {#frag}', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'page://{id}{#section}',
    name: 'Page Section',
    read: async ({ id, section }) => JSON.stringify({ id, section })
  })

  const result = await mcp.readResource('page://doc123#introduction')
  const data = JSON.parse(result.text)
  t.is(data.id, 'doc123')
  t.is(data.section, 'introduction')
})

// RFC 6570 Level 3: Operator expansions

test('RFC 6570 Level 3 - path segments {/var}', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'api://v1{/resource}{/id}',
    name: 'API Resource',
    read: async ({ resource, id }) => JSON.stringify({ resource, id })
  })

  const result = await mcp.readResource('api://v1/users/42')
  const data = JSON.parse(result.text)
  t.is(data.resource, 'users')
  t.is(data.id, '42')
})

test('RFC 6570 Level 3 - label expansion {.ext}', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'file://{name}{.ext}',
    name: 'File with extension',
    read: async ({ name, ext }) => JSON.stringify({ name, ext })
  })

  const result = await mcp.readResource('file://document.pdf')
  const data = JSON.parse(result.text)
  t.is(data.name, 'document')
  t.is(data.ext, 'pdf')
})

test('RFC 6570 Level 3 - query expansion {?query}', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'search://{term}{?limit}',
    name: 'Search',
    read: async ({ term, limit }) => JSON.stringify({ term, limit })
  })

  const result = await mcp.readResource('search://hello?limit=10')
  const data = JSON.parse(result.text)
  t.is(data.term, 'hello')
  t.is(data.limit, '10')
})

test('RFC 6570 Level 3 - query continuation {&more}', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'search://{term}{?limit}{&offset}',
    name: 'Search Paginated',
    read: async ({ term, limit, offset }) => JSON.stringify({ term, limit, offset })
  })

  const result = await mcp.readResource('search://hello?limit=10&offset=20')
  const data = JSON.parse(result.text)
  t.is(data.term, 'hello')
  t.is(data.limit, '10')
  t.is(data.offset, '20')
})

// RFC 6570 Explode modifier

test('RFC 6570 explode - path segments {/path*}', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'files://{/path*}',
    name: 'File Path',
    read: async ({ path }) => JSON.stringify({ path })
  })

  const result = await mcp.readResource('files:///home/user/docs')
  const data = JSON.parse(result.text)
  t.alike(data.path, ['home', 'user', 'docs'])
})

test('RFC 6570 explode - reserved path {+path*}', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'browse://{+path*}',
    name: 'Browse',
    read: async ({ path }) => JSON.stringify({ path })
  })

  const result = await mcp.readResource('browse://a,b,c')
  const data = JSON.parse(result.text)
  t.alike(data.path, ['a', 'b', 'c'])
})

// Mixed templates

test('RFC 6570 mixed - complex template', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'repo://{owner}/{repo}/blob/{branch}{/path*}',
    name: 'Repo File',
    read: async ({ owner, repo, branch, path }) =>
      JSON.stringify({ owner, repo, branch, path })
  })

  const result = await mcp.readResource('repo://acme/myapp/blob/main/src/index.js')
  const data = JSON.parse(result.text)
  t.is(data.owner, 'acme')
  t.is(data.repo, 'myapp')
  t.is(data.branch, 'main')
  t.alike(data.path, ['src', 'index.js'])
})

// URL encoding

test('RFC 6570 encoding - decodes percent-encoded values', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'search://{query}',
    name: 'Search',
    read: async ({ query }) => JSON.stringify({ query })
  })

  const result = await mcp.readResource('search://hello%20world')
  t.is(JSON.parse(result.text).query, 'hello world')
})

test('RFC 6570 encoding - handles special characters', async (t) => {
  const mcp = createMCPServer()

  mcp.addResourceTemplate({
    uriTemplate: 'tag://{name}',
    name: 'Tag',
    read: async ({ name }) => JSON.stringify({ name })
  })

  const result = await mcp.readResource('tag://c%2B%2B')
  t.is(JSON.parse(result.text).name, 'c++')
})
