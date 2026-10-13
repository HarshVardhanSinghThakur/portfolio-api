import assert from 'node:assert/strict'
import { test } from 'node:test'
import { corsHeaders, parseOrigins } from './cors.ts'

const allowed = parseOrigins('https://harsh.me/, https://www.harsh.me')

test('an allowed origin is echoed back with the method and header rules', () => {
  const h = corsHeaders('https://harsh.me', allowed)
  assert.equal(h['Access-Control-Allow-Origin'], 'https://harsh.me')
  assert.equal(h.Vary, 'Origin')
  assert.match(h['Access-Control-Allow-Methods'], /POST/)
})

test('trailing slashes in the config are ignored', () => {
  assert.ok(allowed.has('https://harsh.me'))
})

test('other origins, a missing origin and an empty config get no headers', () => {
  assert.deepEqual(corsHeaders('https://evil.example', allowed), {})
  assert.deepEqual(corsHeaders(undefined, allowed), {})
  assert.deepEqual(corsHeaders('https://harsh.me', parseOrigins(undefined)), {})
})
