const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function event() {
  const listeners = new Set()
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => { for (const listener of listeners) listener(...args) }
  }
}

function extension({ query = async () => [], sendCommand = async () => ({ result: {} }) } = {}) {
  const ports = []
  const timers = []
  const chrome = {
    runtime: {
      connectNative() {
        const port = {
          onMessage: event(),
          onDisconnect: event(),
          posted: [],
          postMessage(msg) {
            if (port.disconnected) throw new Error('Attempting to use a disconnected port')
            // Native messaging serializes with JSON, including dropping undefined.
            port.posted.push(JSON.parse(JSON.stringify(msg)))
          }
        }
        ports.push(port)
        return port
      }
    },
    debugger: { onDetach: event(), attach: async () => {}, sendCommand },
    tabs: { onRemoved: event(), onUpdated: event(), query }
  }
  const context = vm.createContext({
    chrome,
    console: { warn() {} },
    setTimeout: fn => { timers.push(fn); return timers.length },
    clearTimeout() {}
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context)
  return { ports, timers, context }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

describe('extension native connection', () => {
  it('does not send an old asynchronous result through a reconnected port', async () => {
    let finishQuery
    const { ports, timers } = extension({ query: () => new Promise(resolve => { finishQuery = resolve }) })
    const old = ports[0]
    old.onMessage.emit({ jsonrpc: '2.0', id: 1, method: 'tabs.list' })
    old.disconnected = true
    old.onDisconnect.emit()
    timers.shift()()
    const current = ports[1]
    current.onMessage.emit({ jsonrpc: '2.0', id: 1, method: 'ping' })
    await flush()
    finishQuery([{ id: 123 }])
    await flush()
    assert.equal(current.posted.length, 1)
    assert.equal(current.posted[0].result.pong, true)
    assert.equal(old.posted.length, 0)
  })

  it('returns null for handlers without a value so responses retain a result field', async () => {
    const { ports } = extension()
    ports[0].onMessage.emit({ jsonrpc: '2.0', id: 1, method: 'tabs.executeScript', params: { tabId: 123, code: '' } })
    await flush()
    assert.deepEqual(ports[0].posted, [{ jsonrpc: '2.0', id: 1, result: null }])
  })

  it('returns Method not found for inherited object properties', async () => {
    const { ports } = extension()
    ports[0].onMessage.emit({ jsonrpc: '2.0', id: 1, method: 'toString' })
    await flush()
    assert.equal(ports[0].posted[0].error.code, -32601)
  })

  it('rejects malformed requests without an unhandled rejection', async () => {
    const { ports, context } = extension()
    for (const message of [null, [], { id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 123 }]) {
      context.message = message
      await assert.doesNotReject(() => vm.runInContext('handleMessage(message, port)', context))
    }
    assert.equal(ports[0].posted.length, 4)
    assert.ok(ports[0].posted.every(msg => msg.error.code === -32600))
  })

  it('contains postMessage failures when the port disconnects during a request', async () => {
    const { ports, context } = extension()
    ports[0].disconnected = true
    await assert.doesNotReject(() => vm.runInContext("handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }, port)", context))
  })

  it('executes notifications without returning a response', async () => {
    let queries = 0
    const { ports } = extension({ query: async () => { queries++; return [] } })
    ports[0].onMessage.emit({ jsonrpc: '2.0', method: 'tabs.list' })
    await flush()
    assert.equal(queries, 1)
    assert.equal(ports[0].posted.length, 0)
  })
})
