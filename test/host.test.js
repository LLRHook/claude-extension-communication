const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { MAX_HOST_MESSAGE_SIZE, MAX_EXTENSION_MESSAGE_SIZE, encodeNative, createMessageReader } = require('../src/protocol')

function messages(stream) {
  const queue = []
  const waiters = []
  stream.on('data', createMessageReader(msg => {
    if (waiters.length) waiters.shift()(msg)
    else queue.push(msg)
  }))
  return {
    async next() {
      if (queue.length) return queue.shift()
      let receive
      const message = new Promise(resolve => { receive = resolve; waiters.push(receive) })
      let timer
      try {
        return await Promise.race([
          message,
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Timed out waiting for message')), 2000)
          })
        ])
      } finally {
        clearTimeout(timer)
        const index = waiters.indexOf(receive)
        if (index !== -1) waiters.splice(index, 1)
      }
    },
    queue
  }
}

async function bridge(t, { socket } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-host-'))
  const sockPath = socket || (process.platform === 'win32'
    ? '\\\\.\\pipe\\blade-host-' + path.basename(dir)
    : path.join(dir, 'bridge.sock'))
  // Override only the socket location; run the real host with real stdio and IPC.
  const script = `
    require('./src/protocol').ipcSocketPath = () => process.argv[1]
    require('./src/host').startHost()
  `
  const child = spawn(process.execPath, ['-e', script, sockPath], {
    cwd: path.resolve(__dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const closed = once(child, 'close')
  const outgoing = messages(child.stdout)
  const clients = new Set()
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.on('error', () => {})
  t.after(async () => {
    for (const client of clients) client.destroy()
    child.stdin.destroy()
    child.kill()
    await closed
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function connect() {
    const deadline = Date.now() + 2000
    while (true) {
      if (child.exitCode !== null) throw new Error('Host exited: ' + stderr)
      const client = net.createConnection(sockPath)
      const incoming = messages(client)
      try {
        await once(client, 'connect')
        clients.add(client)
        return { client, incoming }
      } catch (err) {
        client.destroy()
        if (!['ENOENT', 'ECONNREFUSED'].includes(err.code) || Date.now() >= deadline) throw err
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
  }

  return { child, closed, outgoing, connect, sockPath, stderr: () => stderr }
}

describe('native host', () => {
  it('routes simultaneous requests with identical client IDs to their own clients', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const a = await host.connect()
    const b = await host.connect()
    a.client.write(encodeNative({ jsonrpc: '2.0', id: 1, method: 'tabs.list' }))
    b.client.write(encodeNative({ jsonrpc: '2.0', id: 1, method: 'ping' }))

    const first = await host.outgoing.next()
    const second = await host.outgoing.next()
    assert.notEqual(first.id, second.id, 'host request IDs must be unique across clients')
    // Return the second response first to exercise out-of-order completion.
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: second.id, result: second.method }))
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: first.id, result: first.method }))
    assert.deepEqual(await a.incoming.next(), { jsonrpc: '2.0', id: 1, result: 'tabs.list' })
    assert.deepEqual(await b.incoming.next(), { jsonrpc: '2.0', id: 1, result: 'ping' })
  })

  it('does not send a disconnected client response to another client', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const a = await host.connect()
    a.client.write(encodeNative({ jsonrpc: '2.0', id: 'old', method: 'tabs.list' }))
    const request = await host.outgoing.next()
    a.client.destroy()
    await once(a.client, 'close')
    const b = await host.connect()
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: request.id, result: 'private' }))
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', method: 'ready', params: {} }))
    assert.equal((await b.incoming.next()).method, 'ready')
  })

  it('disconnects malformed clients without killing the native host', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const bad = await host.connect()
    const closed = once(bad.client, 'close')
    const invalid = encodeNative({})
    invalid[4] = 0x21
    bad.client.write(invalid)
    await closed

    const good = await host.connect()
    good.client.write(encodeNative({ jsonrpc: '2.0', id: 7, method: 'ping' }))
    const request = await host.outgoing.next()
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: request.id, result: 'alive' }))
    assert.equal((await good.incoming.next()).result, 'alive')
    assert.equal(host.child.exitCode, null)
  })

  it('closes connected clients and exits when Chrome closes stdin', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const { client } = await host.connect()
    const clientClosed = once(client, 'close')
    host.child.stdin.end()
    await clientClosed
    const [code] = await host.closed
    assert.equal(code, 0, host.stderr())
    if (process.platform !== 'win32') assert.equal(fs.existsSync(host.sockPath), false)
  })

  it('preserves string and null IDs when returning results and errors', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const { client, incoming } = await host.connect()
    for (const id of ['request-abc', null]) {
      client.write(encodeNative({ jsonrpc: '2.0', id, method: 'missing' }))
      const request = await host.outgoing.next()
      const error = { code: -32601, message: 'Method not found' }
      host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: request.id, error }))
      assert.deepEqual(await incoming.next(), { jsonrpc: '2.0', id, error })
    }
  })

  it('broadcasts notifications and drops responses with unknown IDs', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const a = await host.connect()
    const b = await host.connect()
    const notification = { jsonrpc: '2.0', method: 'status', params: { ready: true } }
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: 'unknown', result: 'private' }))
    host.child.stdin.write(encodeNative(notification))
    assert.deepEqual(await a.incoming.next(), notification)
    assert.deepEqual(await b.incoming.next(), notification)
  })

  it('rejects invalid request envelopes without forwarding them to Chrome', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const { client, incoming } = await host.connect()
    for (const invalid of [null, [], { id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping', params: 'bad' }]) {
      client.write(encodeNative(invalid))
      assert.equal((await incoming.next()).error.code, -32600)
    }
    client.write(encodeNative({ jsonrpc: '2.0', id: 3, method: 'ping' }))
    assert.equal((await host.outgoing.next()).method, 'ping')
  })

  it('rejects an oversized client header while keeping the host available', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const { client } = await host.connect()
    const frame = encodeNative('')
    if (os.endianness() === 'LE') frame.writeUInt32LE(MAX_HOST_MESSAGE_SIZE + 1)
    else frame.writeUInt32BE(MAX_HOST_MESSAGE_SIZE + 1)
    const closed = once(client, 'close')
    client.write(frame.subarray(0, 4))
    await closed
    const good = await host.connect()
    good.client.write(encodeNative({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    assert.equal((await host.outgoing.next()).method, 'ping')
  })

  it('allows extension responses larger than the host-to-Chrome limit', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const { client, incoming } = await host.connect()
    client.write(encodeNative({ jsonrpc: '2.0', id: 1, method: 'tabs.screenshot' }))
    const request = await host.outgoing.next()
    const result = 'x'.repeat(MAX_HOST_MESSAGE_SIZE + 1)
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: request.id, result }))
    assert.equal((await incoming.next()).result, result)
  })

  it('shuts down cleanly for an oversized Chrome header', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const { client } = await host.connect()
    const frame = encodeNative('')
    if (os.endianness() === 'LE') frame.writeUInt32LE(MAX_EXTENSION_MESSAGE_SIZE + 1)
    else frame.writeUInt32BE(MAX_EXTENSION_MESSAGE_SIZE + 1)
    const closed = once(client, 'close')
    host.child.stdin.write(frame.subarray(0, 4))
    await closed
    assert.equal((await host.closed)[0], 1)
    assert.match(host.stderr(), /Invalid native message length/)
    assert.doesNotMatch(host.stderr(), /at .*src\/protocol\.js/)
  })

  it('reports a truncated Chrome frame at EOF', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    await host.connect()
    host.child.stdin.end(encodeNative({ jsonrpc: '2.0', method: 'status' }).subarray(0, -1))
    assert.equal((await host.closed)[0], 1)
    assert.match(host.stderr(), /Truncated native message/)
  })

  it('shuts down for malformed native response envelopes', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const { client } = await host.connect()
    const closed = once(client, 'close')
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: 1 }))
    await closed
    assert.equal((await host.closed)[0], 1)
    assert.match(host.stderr(), /Invalid native response/)
  })

  it('does not replace a live host socket', { timeout: 5000 }, async t => {
    const first = await bridge(t)
    await first.connect()
    const second = await bridge(t, { socket: first.sockPath })
    assert.equal((await second.closed)[0], 1)
    assert.match(second.stderr(), /EADDRINUSE/)
    const { client } = await first.connect()
    client.write(encodeNative({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    assert.equal((await first.outgoing.next()).method, 'ping')
  })

  it('reclaims a stale Unix socket after an abruptly terminated host', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
    const first = await bridge(t)
    await first.connect()
    first.child.kill('SIGKILL')
    await first.closed
    assert.equal(fs.existsSync(first.sockPath), true)
    const second = await bridge(t, { socket: first.sockPath })
    const { client } = await second.connect()
    client.write(encodeNative({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    assert.equal((await second.outgoing.next()).method, 'ping')
    assert.equal(fs.statSync(first.sockPath).mode & 0o777, 0o600)
  })

  it('preserves regular files at the Unix socket path', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-file-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const sockPath = path.join(dir, 'keep.txt')
    fs.writeFileSync(sockPath, 'keep this file')
    const host = await bridge(t, { socket: sockPath })
    assert.equal((await host.closed)[0], 1)
    assert.equal(fs.readFileSync(sockPath, 'utf8'), 'keep this file')
  })
})
