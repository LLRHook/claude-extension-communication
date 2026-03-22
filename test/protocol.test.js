const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert')

// Fresh require for each test file to get independent nextId counter
const {
  encodeNative,
  decodeNative,
  createMessageReader,
  ipcSocketPath,
  rpc,
  rpcResult,
  rpcError,
  rpcNotify
} = require('../src/protocol')

describe('encodeNative / decodeNative', () => {
  it('roundtrips a single message', () => {
    const msg = { hello: 'world', num: 42 }
    const encoded = encodeNative(msg)
    const { messages, remainder } = decodeNative(encoded)
    assert.strictEqual(messages.length, 1)
    assert.deepStrictEqual(messages[0], msg)
    assert.strictEqual(remainder.length, 0)
  })

  it('returns 0 messages for a partial buffer', () => {
    const msg = { key: 'value' }
    const encoded = encodeNative(msg)
    // Chop off last byte so payload is incomplete
    const partial = encoded.subarray(0, encoded.length - 1)
    const { messages, remainder } = decodeNative(partial)
    assert.strictEqual(messages.length, 0)
    assert.strictEqual(remainder.length, partial.length)
  })

  it('decodes multiple messages in one buffer', () => {
    const a = { a: 1 }
    const b = { b: 2 }
    const c = { c: 3 }
    const buf = Buffer.concat([encodeNative(a), encodeNative(b), encodeNative(c)])
    const { messages, remainder } = decodeNative(buf)
    assert.strictEqual(messages.length, 3)
    assert.deepStrictEqual(messages[0], a)
    assert.deepStrictEqual(messages[1], b)
    assert.deepStrictEqual(messages[2], c)
    assert.strictEqual(remainder.length, 0)
  })

  it('handles a large message (100KB payload)', () => {
    const big = { data: 'x'.repeat(100 * 1024) }
    const encoded = encodeNative(big)
    const { messages, remainder } = decodeNative(encoded)
    assert.strictEqual(messages.length, 1)
    assert.deepStrictEqual(messages[0], big)
    assert.strictEqual(remainder.length, 0)
  })

  it('handles an empty buffer', () => {
    const { messages, remainder } = decodeNative(Buffer.alloc(0))
    assert.strictEqual(messages.length, 0)
    assert.strictEqual(remainder.length, 0)
  })
})

describe('rpc helpers', () => {
  it('rpc() returns valid JSON-RPC 2.0 with incrementing ids', () => {
    const first = rpc('methodA', { foo: 1 })
    const second = rpc('methodB')

    assert.strictEqual(first.jsonrpc, '2.0')
    assert.strictEqual(first.method, 'methodA')
    assert.deepStrictEqual(first.params, { foo: 1 })
    assert.strictEqual(typeof first.id, 'number')

    assert.strictEqual(second.jsonrpc, '2.0')
    assert.strictEqual(second.method, 'methodB')
    assert.deepStrictEqual(second.params, {})
    assert.strictEqual(second.id, first.id + 1)
  })

  it('rpcResult() returns correct structure', () => {
    const r = rpcResult(7, { ok: true })
    assert.strictEqual(r.jsonrpc, '2.0')
    assert.strictEqual(r.id, 7)
    assert.deepStrictEqual(r.result, { ok: true })
  })

  it('rpcError() returns correct structure with error code', () => {
    const e = rpcError(9, -32600, 'Invalid request')
    assert.strictEqual(e.jsonrpc, '2.0')
    assert.strictEqual(e.id, 9)
    assert.strictEqual(e.error.code, -32600)
    assert.strictEqual(e.error.message, 'Invalid request')
  })

  it('rpcNotify() has no id field', () => {
    const n = rpcNotify('ping', { ts: 123 })
    assert.strictEqual(n.jsonrpc, '2.0')
    assert.strictEqual(n.method, 'ping')
    assert.deepStrictEqual(n.params, { ts: 123 })
    assert.strictEqual(n.id, undefined)
    assert.ok(!('id' in n))
  })
})

describe('createMessageReader', () => {
  it('handles partial chunks across multiple calls', () => {
    const collected = []
    const reader = createMessageReader(msg => collected.push(msg))

    const full = encodeNative({ step: 1 })
    // Split in the middle
    const mid = Math.floor(full.length / 2)
    reader(full.subarray(0, mid))
    assert.strictEqual(collected.length, 0)

    reader(full.subarray(mid))
    assert.strictEqual(collected.length, 1)
    assert.deepStrictEqual(collected[0], { step: 1 })
  })

  it('handles multiple messages in one chunk', () => {
    const collected = []
    const reader = createMessageReader(msg => collected.push(msg))

    const buf = Buffer.concat([
      encodeNative({ x: 1 }),
      encodeNative({ x: 2 }),
      encodeNative({ x: 3 })
    ])
    reader(buf)
    assert.strictEqual(collected.length, 3)
    assert.deepStrictEqual(collected[0], { x: 1 })
    assert.deepStrictEqual(collected[1], { x: 2 })
    assert.deepStrictEqual(collected[2], { x: 3 })
  })
})

describe('ipcSocketPath', () => {
  it('returns a string containing blade-bridge on all platforms', () => {
    const p = ipcSocketPath()
    assert.strictEqual(typeof p, 'string')
    assert.ok(p.includes('blade-bridge'), `Expected path to contain "blade-bridge", got: ${p}`)
  })
})
