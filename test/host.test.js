const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { MAX_HOST_MESSAGE_SIZE, MAX_EXTENSION_MESSAGE_SIZE, encodeNative, createMessageReader } = require('../src/protocol')
const { hostBinaryPath } = require('../src/native')

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

async function bounded(promise, ms, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms)
    })])
  } finally { clearTimeout(timer) }
}

async function bridge(t, { socket, launcher = false, writeTimeoutMs = 10000, readOutput = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-host-'))
  const sockPath = socket || (process.platform === 'win32'
    ? '\\\\.\\pipe\\blade-host-' + path.basename(dir)
    : path.join(dir, 'bridge.sock'))
  // Exercise Rust directly for crash/signal lifecycle tests. A separate parity
  // case enters through blade.js, overriding only the synthetic socket location.
  const script = `
    const socket = process.argv[1]
    const writeTimeoutMs = Number(process.argv[2])
    const host = require('./src/host')
    const startHost = host.startHost
    host.startHost = () => {
      const native = startHost({ socketPath: socket, writeTimeoutMs })
      // The fixture can force only the child it started, through its owner.
      process.on('message', message => { if (message === 'stop-host') native.kill('SIGKILL') })
      native.once('exit', () => { if (process.connected) process.disconnect() })
      return native
    }
    process.argv = [process.argv[0], 'blade.js', 'chrome-extension://synthetic/']
    require('./blade')
  `
  const child = spawn(launcher ? process.execPath : hostBinaryPath(), launcher
    ? ['-e', script, sockPath, String(writeTimeoutMs)]
    : ['--socket', sockPath, '--write-timeout-ms', String(writeTimeoutMs)], {
    cwd: path.resolve(__dirname, '..'),
    stdio: launcher ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe']
  })
  const closed = once(child, 'close')
  const exited = once(child, 'exit')
  const outgoing = readOutput ? messages(child.stdout) : null
  const clients = new Set()
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.on('error', () => {})
  t.after(async () => {
    for (const client of clients) client.destroy()
    child.stdin.end()
    child.stdout.resume()
    try {
      await bounded(closed, 1000, 'Host did not stop at EOF')
    } catch {
      if (launcher && child.connected) child.send('stop-host', () => {})
      else child.kill('SIGKILL')
      await bounded(closed, 1000, 'Owned host did not stop after forced teardown')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  async function connect({ read = true } = {}) {
    const deadline = Date.now() + 2000
    while (true) {
      if (child.exitCode !== null) throw new Error('Host exited: ' + stderr)
      const client = net.createConnection(sockPath)
      const incoming = read ? messages(client) : null
      const closed = new Promise(resolve => client.once('close', resolve))
      client.on('error', () => {})
      if (!read) client.pause()
      try {
        await once(client, 'connect')
        clients.add(client)
        return { client, incoming, closed }
      } catch (err) {
        client.destroy()
        if (!['ENOENT', 'ECONNREFUSED'].includes(err.code) || Date.now() >= deadline) throw err
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
  }

  return { child, closed, exited, outgoing, connect, sockPath, stderr: () => stderr }
}

describe('native host', () => {
  it('runs the Rust host through the default blade.js host entry point', { timeout: 5000 }, async t => {
    const host = await bridge(t, { launcher: true })
    const { client, incoming } = await host.connect()
    client.write(encodeNative({ jsonrpc: '2.0', id: 'entry', method: 'ping' }))
    const request = await host.outgoing.next()
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: request.id, result: { pong: true } }))
    assert.deepEqual(await incoming.next(), { jsonrpc: '2.0', id: 'entry', result: { pong: true } })
    host.child.stdin.end()
    assert.equal((await host.closed)[0], 0, host.stderr())
  })

  it('forwards launcher SIGTERM to Rust and closes the socket', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
    const host = await bridge(t, { launcher: true })
    const { client } = await host.connect()
    const closed = new Promise(resolve => client.once('close', resolve))
    host.child.kill('SIGTERM')
    await closed
    assert.equal((await host.closed)[0], 0, host.stderr())
    assert.equal(fs.existsSync(host.sockPath), false)
  })

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
    await a.closed
    const b = await host.connect()
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: request.id, result: 'private' }))
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', method: 'ready', params: {} }))
    assert.equal((await b.incoming.next()).method, 'ready')
  })

  it('disconnects malformed clients without killing the native host', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const bad = await host.connect()
    const closed = bad.closed
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
    const clientClosed = new Promise(resolve => client.once('close', resolve))
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
      const response = await incoming.next()
      assert.equal(response.error.code, -32600)
      assert.equal(response.id, invalid?.jsonrpc === '2.0' ? invalid.id : null)
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
    const closed = new Promise(resolve => client.once('close', resolve))
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
    const closed = new Promise(resolve => client.once('close', resolve))
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
    const closed = new Promise(resolve => client.once('close', resolve))
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

  it('handles split headers/UTF-8 and coalesced messages on both transports', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const { client, incoming } = await host.connect()
    const first = encodeNative({ jsonrpc: '2.0', id: 42, method: 'echo', params: { text: '🌍 日本語' } })
    for (const byte of first) client.write(Buffer.from([byte]))
    client.write(Buffer.concat([
      encodeNative({ jsonrpc: '2.0', id: 'two', method: 'echo' }),
      encodeNative({ jsonrpc: '2.0', method: 'notification', params: [] })
    ]))
    const requests = [await host.outgoing.next(), await host.outgoing.next(), await host.outgoing.next()]
    assert.deepEqual(requests[0].params, { text: '🌍 日本語' })
    assert.equal('id' in requests[2], false)
    const response = encodeNative({ jsonrpc: '2.0', id: requests[0].id, result: '🌍' })
    for (const byte of response.subarray(0, 7)) host.child.stdin.write(Buffer.from([byte]))
    host.child.stdin.write(Buffer.concat([
      response.subarray(7), encodeNative({ jsonrpc: '2.0', id: requests[1].id, result: 'second' })
    ]))
    assert.deepEqual(await incoming.next(), { jsonrpc: '2.0', id: 42, result: '🌍' })
    assert.deepEqual(await incoming.next(), { jsonrpc: '2.0', id: 'two', result: 'second' })
  })

  it('preserves escaped UTF-16 strings and deeply nested opaque data', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const { client, incoming } = await host.connect()
    let data = '\ud800'
    for (let i = 0; i < 256; i++) data = [data]
    const id = '\udfff'
    client.write(encodeNative({ jsonrpc: '2.0', id, method: 'echo', params: { data } }))
    const request = await host.outgoing.next()
    assert.deepEqual(request.params, { data })
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: request.id, result: data }))
    assert.deepEqual(await incoming.next(), { jsonrpc: '2.0', id, result: data })
  })

  it('rejects nonowner result injection and distinguishes string/numeric wire IDs', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const a = await host.connect()
    const b = await host.connect()
    a.client.write(encodeNative({ jsonrpc: '2.0', id: 'owner', method: 'ping' }))
    const request = await host.outgoing.next()
    b.client.write(encodeNative({ jsonrpc: '2.0', id: request.id, result: 'forged' }))
    assert.equal((await b.incoming.next()).error.code, -32600)
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: String(request.id), result: 'wrong type' }))
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: request.id, result: 'real' }))
    assert.deepEqual(await a.incoming.next(), { jsonrpc: '2.0', id: 'owner', result: 'real' })
    assert.equal(host.outgoing.queue.length, 0)
  })

  for (const payload of [Buffer.from([0x22, 0xff, 0x22]), Buffer.from('!'), Buffer.from('\ufeff{}')]) {
    it('rejects malformed UTF-8/JSON at native input: ' + payload.toString('hex'), { timeout: 5000 }, async t => {
      const host = await bridge(t)
      await host.connect()
      const header = encodeNative('x').subarray(0, 4)
      if (os.endianness() === 'LE') header.writeUInt32LE(payload.length)
      else header.writeUInt32BE(payload.length)
      host.child.stdin.write(Buffer.concat([header, payload]))
      assert.equal((await host.closed)[0], 1)
      assert.match(host.stderr(), /Invalid (UTF-8|JSON)/)
    })
  }

  it('disconnects invalid UTF-8 and truncated clients while preserving other clients', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const good = await host.connect()
    const invalidUtf8 = Buffer.concat([encodeNative('x').subarray(0, 4), Buffer.from([0x22, 0xff, 0x22])])
    for (const frame of [Buffer.from([1]), encodeNative({ jsonrpc: '2.0' }).subarray(0, -1), invalidUtf8]) {
      const bad = await host.connect()
      const closed = bad.closed
      bad.client.end(frame)
      await closed
    }
    good.client.write(encodeNative({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    assert.equal((await host.outgoing.next()).method, 'ping')
  })

  it('does not starve native input with many idle clients', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const peers = []
    for (let i = 0; i < 12; i++) peers.push(await host.connect())
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', method: 'ready' }))
    for (const peer of peers) assert.equal((await peer.incoming.next()).method, 'ready')
  })

  it('drains an accepted response at clean native EOF before closing clients', { timeout: 5000 }, async t => {
    const host = await bridge(t, { writeTimeoutMs: 1000 })
    const peer = await host.connect({ read: false })
    peer.client.write(encodeNative({ jsonrpc: '2.0', id: 'last', method: 'large' }))
    const request = await host.outgoing.next()
    const result = 'x'.repeat(2 * MAX_HOST_MESSAGE_SIZE)
    host.child.stdin.end(encodeNative({ jsonrpc: '2.0', id: request.id, result }))
    // Keep the real pipe full while EOF is processed, then let it drain.
    await new Promise(resolve => setTimeout(resolve, 50))
    const incoming = messages(peer.client)
    peer.client.resume()
    assert.deepEqual(await incoming.next(), { jsonrpc: '2.0', id: 'last', result })
    assert.equal((await host.closed)[0], 0, host.stderr())
  })

  for (const launcher of [false, true]) {
    it(`survives a slow client without delaying another client (launcher=${launcher})`, { timeout: 5000 }, async t => {
      const host = await bridge(t, { launcher, writeTimeoutMs: 100 })
      const slow = await host.connect({ read: false })
      slow.client.write(Buffer.concat([
        encodeNative({ jsonrpc: '2.0', id: 1, method: 'large' }),
        encodeNative({ jsonrpc: '2.0', id: 2, method: 'pending' })
      ]))
      const first = await host.outgoing.next()
      const pending = await host.outgoing.next()
      host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: first.id, result: 'x'.repeat(2 * MAX_HOST_MESSAGE_SIZE) }))
      const good = await host.connect()
      good.client.write(encodeNative({ jsonrpc: '2.0', id: 2, method: 'ping' }))
      const second = await host.outgoing.next()
      host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: second.id, result: 'alive' }))
      assert.deepEqual(await good.incoming.next(), { jsonrpc: '2.0', id: 2, result: 'alive' })
      // Remain unread beyond the write deadline, even after the other response.
      await new Promise(resolve => setTimeout(resolve, 200))
      slow.client.resume()
      await bounded(slow.closed, 1000, 'Stalled IPC peer remained connected')
      host.child.stdin.write(Buffer.concat([
        encodeNative({ jsonrpc: '2.0', id: pending.id, result: 'private late response' }),
        encodeNative({ jsonrpc: '2.0', method: 'ready' })
      ]))
      assert.equal((await good.incoming.next()).method, 'ready')
      assert.equal(good.incoming.queue.length, 0)
      assert.equal(host.child.exitCode, null)
    })

    it(`fails with a bounded timeout when Chrome stops reading stdout (launcher=${launcher})`, { timeout: 5000 }, async t => {
      const host = await bridge(t, { launcher, writeTimeoutMs: 100, readOutput: false })
      const { client } = await host.connect()
      // Fill the real transport with bounded, legal frames. A single write can
      // fit in an OS/libuv buffer and is not proof of backpressure on Windows.
      const frame = encodeNative({ jsonrpc: '2.0', method: 'large', params: { data: 'x'.repeat(512 * 1024) } })
      for (let i = 0; i < 32 && host.child.exitCode === null && !client.destroyed; i++) {
        await new Promise(resolve => client.write(frame, resolve))
        await new Promise(resolve => setImmediate(resolve))
      }
      // Observe process termination while stdout is still unread. Then drain the
      // parent's pipe so Node can emit close and reap every owned handle.
      assert.equal((await bounded(host.exited, 2000, 'Host did not exit with stalled stdout'))[0], 1)
      host.child.stdout.resume()
      assert.equal((await host.closed)[0], 1)
      assert.match(host.stderr(), /Write timed out/)
    })
  }

  it('bounds EOF teardown with an unread client and preserves another host', { timeout: 5000 }, async t => {
    const independent = await bridge(t)
    const other = await independent.connect()
    const host = await bridge(t, { writeTimeoutMs: 100 })
    const slow = await host.connect({ read: false })
    slow.client.write(encodeNative({ jsonrpc: '2.0', id: 1, method: 'large' }))
    const request = await host.outgoing.next()
    host.child.stdin.end(encodeNative({ jsonrpc: '2.0', id: request.id, result: 'x'.repeat(2 * MAX_HOST_MESSAGE_SIZE) }))
    assert.equal((await bounded(host.exited, 1000, 'EOF drain exceeded its deadline'))[0], 0)
    slow.client.destroy()
    await host.closed
    other.client.write(encodeNative({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    assert.equal((await independent.outgoing.next()).method, 'ping')
    assert.equal(independent.child.exitCode, null)
  })

  it('exits for a broken Chrome stdout pipe', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const { client } = await host.connect()
    host.child.stdout.destroy()
    client.write(encodeNative({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    assert.equal((await host.closed)[0], 1)
    assert.match(host.stderr(), /[Bb]roken pipe|pipe.*closed|os error/i)
  })

  it('preserves symlinks and directories at the socket path', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-symlink-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const target = path.join(dir, 'keep')
    fs.writeFileSync(target, 'keep')
    const link = path.join(dir, 'bridge.sock')
    fs.symlinkSync(target, link)
    const directory = path.join(dir, 'directory')
    fs.mkdirSync(directory)
    for (const socket of [link, directory]) {
      const host = await bridge(t, { socket })
      assert.equal((await host.closed)[0], 1)
    }
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep')
  })

  it('does not unlink a replacement path on shutdown', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
    const host = await bridge(t)
    await host.connect()
    fs.unlinkSync(host.sockPath)
    fs.writeFileSync(host.sockPath, 'replacement')
    host.child.stdin.end()
    assert.equal((await host.closed)[0], 0)
    assert.equal(fs.readFileSync(host.sockPath, 'utf8'), 'replacement')
  })

  it('closes clients and removes its socket on SIGTERM', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
    const host = await bridge(t)
    const { client } = await host.connect()
    const closed = new Promise(resolve => client.once('close', resolve))
    assert.equal(fs.statSync(host.sockPath).mode & 0o777, 0o600)
    host.child.kill('SIGTERM')
    await closed
    assert.equal((await host.closed)[0], 0)
    assert.equal(fs.existsSync(host.sockPath), false)
  })

  it('serializes simultaneous stale recovery without replacing the winner', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
    const old = await bridge(t)
    await old.connect()
    old.child.kill('SIGKILL')
    await old.closed
    const a = await bridge(t, { socket: old.sockPath })
    const b = await bridge(t, { socket: old.sockPath })
    const loser = await Promise.race([a.closed.then(() => a), b.closed.then(() => b)])
    assert.equal(loser.child.exitCode, 1)
    const winner = loser === a ? b : a
    const { client } = await winner.connect()
    client.write(encodeNative({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    assert.equal((await winner.outgoing.next()).method, 'ping')
  })

  it('preserves unknown lock contents and refuses a symlink lock', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-lock-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const socket = path.join(dir, 'bridge.sock')
    const target = path.join(dir, 'keep')
    fs.writeFileSync(target, 'keep')
    fs.symlinkSync(target, socket + '.lock')
    const rejected = await bridge(t, { socket })
    assert.equal((await rejected.closed)[0], 1)
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep')
    fs.unlinkSync(socket + '.lock')
    fs.writeFileSync(socket + '.lock', 'unknown lock contents')
    const host = await bridge(t, { socket })
    await host.connect()
    host.child.stdin.end()
    assert.equal((await host.closed)[0], 0)
    assert.equal(fs.readFileSync(socket + '.lock', 'utf8'), 'unknown lock contents')
  })

  it('keeps long-running requests pending beyond the write deadline', { timeout: 5000 }, async t => {
    const host = await bridge(t, { writeTimeoutMs: 50 })
    const { client, incoming } = await host.connect()
    client.write(encodeNative({ jsonrpc: '2.0', id: 1, method: 'wait' }))
    const request = await host.outgoing.next()
    await new Promise(resolve => setTimeout(resolve, 100))
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', id: request.id, result: 'finished' }))
    assert.equal((await incoming.next()).result, 'finished')
  })

  it('rejects an excess connection and remains available to existing clients', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const peers = []
    for (let i = 0; i < 32; i++) peers.push(await host.connect())
    // Ensure all connections have been accepted before adding the 33rd.
    host.child.stdin.write(encodeNative({ jsonrpc: '2.0', method: 'ready' }))
    for (const peer of peers) await peer.incoming.next()
    // Windows can report the host's capacity rejection during pipe connect,
    // before a socket is returned. Other failures must still fail this case.
    const excess = await host.connect().catch(error => {
      assert.equal(process.platform, 'win32')
      assert.equal(error.code, 'EPIPE')
      return null
    })
    if (excess) await excess.closed
    peers[0].client.write(encodeNative({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    assert.equal((await host.outgoing.next()).method, 'ping')
  })

  it('accepts a client frame exactly at the host limit', { timeout: 5000 }, async t => {
    const host = await bridge(t)
    const { client } = await host.connect()
    const request = { jsonrpc: '2.0', id: 1, method: 'echo', params: { data: '' } }
    const overhead = Buffer.byteLength(JSON.stringify(request))
    request.params.data = 'x'.repeat(MAX_HOST_MESSAGE_SIZE - overhead)
    const frame = encodeNative(request)
    assert.equal(frame.length, MAX_HOST_MESSAGE_SIZE + 4)
    client.write(frame)
    const outgoing = await host.outgoing.next()
    assert.equal(outgoing.params.data.length, request.params.data.length)
  })
})
