const { describe, it } = require('node:test')
const assert = require('node:assert')
const os = require('node:os')

// Fresh require for each test file to get independent nextId counter
const {
  encodeNative,
  decodeNative,
  createMessageReader,
  ipcSocketPath,
  rpc,
  rpcResult,
  rpcError,
  rpcNotify,
  MAX_HOST_MESSAGE_SIZE,
  MAX_EXTENSION_MESSAGE_SIZE
} = require('../src/protocol')

function lengthHeader(length) {
  const header = Buffer.alloc(4)
  if (os.endianness() === 'LE') header.writeUInt32LE(length)
  else header.writeUInt32BE(length)
  return header
}

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

  it('frames non-ASCII JSON using byte length and native endianness', () => {
    const msg = { text: 'こんにちは 🌍' }
    const frame = encodeNative(msg)
    assert.deepStrictEqual(frame.subarray(0, 4), lengthHeader(Buffer.byteLength(JSON.stringify(msg))))
    assert.deepStrictEqual(decodeNative(frame).messages, [msg])
  })

  it('rejects zero and oversized lengths immediately from the header', () => {
    assert.throws(() => decodeNative(lengthHeader(0)), /Invalid native message length/)
    assert.throws(() => decodeNative(lengthHeader(MAX_EXTENSION_MESSAGE_SIZE + 1)), /Invalid native message length/)
    assert.throws(() => decodeNative(lengthHeader(MAX_HOST_MESSAGE_SIZE + 1), MAX_HOST_MESSAGE_SIZE), /Invalid native message length/)
  })

  it('accepts exactly the configured size and rejects larger encoded messages', () => {
    assert.deepStrictEqual(decodeNative(encodeNative('x', 3), 3).messages, ['x'])
    assert.throws(() => encodeNative('xx', 3), /exceeds 3 bytes/)
  })

  it('rejects malformed JSON and invalid UTF-8 instead of replacing bytes', () => {
    assert.throws(() => decodeNative(Buffer.concat([lengthHeader(1), Buffer.from('!')])), SyntaxError)
    assert.throws(() => decodeNative(Buffer.concat([lengthHeader(3), Buffer.from([0x22, 0xff, 0x22])])), /utf-8/i)
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

  it('handles byte-by-byte fragmentation across headers and UTF-8 payloads', () => {
    const collected = []
    const reader = createMessageReader(msg => collected.push(msg))
    const expected = [{ text: '🌍' }, { next: true }]
    for (const byte of Buffer.concat(expected.map(msg => encodeNative(msg)))) reader(Buffer.from([byte]))
    reader.end()
    assert.deepStrictEqual(collected, expected)
  })

  it('limits each frame rather than the combined chunk size', () => {
    const collected = []
    const reader = createMessageReader(msg => collected.push(msg), { maxMessageSize: 3 })
    reader(Buffer.concat([encodeNative('x'), encodeNative('y')]))
    assert.deepStrictEqual(collected, ['x', 'y'])
  })

  it('reports an invalid frame once and stops reading that connection', () => {
    const collected = []
    const errors = []
    const reader = createMessageReader(msg => collected.push(msg), { onError: err => errors.push(err) })
    reader(Buffer.concat([encodeNative({ ok: true }), lengthHeader(0), encodeNative({ ignored: true })]))
    reader(encodeNative({ ignored: true }))
    reader.end()
    assert.deepStrictEqual(collected, [{ ok: true }])
    assert.strictEqual(errors.length, 1)
    assert.match(errors[0].message, /Invalid native message length/)
  })

  it('rejects oversized headers before receiving their payloads', () => {
    const errors = []
    const reader = createMessageReader(() => assert.fail('Unexpected message'), {
      maxMessageSize: 10,
      onError: err => errors.push(err)
    })
    reader(lengthHeader(11))
    assert.strictEqual(errors.length, 1)
  })

  it('reports malformed JSON through onError', () => {
    const errors = []
    const reader = createMessageReader(() => assert.fail('Unexpected message'), { onError: err => errors.push(err) })
    reader(Buffer.concat([lengthHeader(1), Buffer.from('!')]))
    assert.strictEqual(errors.length, 1)
    assert.ok(errors[0] instanceof SyntaxError)
  })

  it('detects truncated headers and payloads at EOF', () => {
    for (const frame of [Buffer.from([1]), encodeNative({ x: 1 }).subarray(0, -1)]) {
      const errors = []
      const reader = createMessageReader(() => assert.fail('Unexpected message'), { onError: err => errors.push(err) })
      reader(frame)
      reader.end()
      reader.end()
      assert.strictEqual(errors.length, 1)
      assert.match(errors[0].message, /Truncated native message/)
    }
  })
})

describe('ipcSocketPath', () => {
  it('returns a string containing blade-bridge on all platforms', () => {
    const p = ipcSocketPath()
    assert.strictEqual(typeof p, 'string')
    assert.ok(p.includes('blade-bridge'), `Expected path to contain "blade-bridge", got: ${p}`)
  })
})
