const { describe, it } = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { encodeNative, decodeNative, createMessageReader, rpc } = require('../src/protocol')

function tempSocket() {
  const id = Math.random().toString(36).slice(2, 10)
  if (process.platform === 'win32') return '\\\\.\\pipe\\blade-test-' + id
  return path.join(os.tmpdir(), 'blade-test-' + id + '.sock')
}

function cleanup(sockPath) {
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(sockPath) } catch {}
  }
}

describe('IPC server-client', () => {
  it('client connects, sends RPC, server echoes back', async () => {
    const sockPath = tempSocket()

    const server = net.createServer(client => {
      client.on('data', createMessageReader(msg => {
        // Echo the message back as-is
        client.write(encodeNative(msg))
      }))
    })

    await new Promise((resolve, reject) => {
      server.listen(sockPath, resolve)
      server.on('error', reject)
    })

    try {
      const response = await new Promise((resolve, reject) => {
        const conn = net.createConnection(sockPath)
        conn.on('error', reject)
        conn.on('data', createMessageReader(msg => {
          conn.end()
          resolve(msg)
        }))
        conn.on('connect', () => {
          const msg = rpc('test.echo', { value: 42 })
          conn.write(encodeNative(msg))
        })
      })

      assert.strictEqual(response.jsonrpc, '2.0')
      assert.strictEqual(response.method, 'test.echo')
      assert.deepStrictEqual(response.params, { value: 42 })
    } finally {
      await new Promise(resolve => server.close(resolve))
      cleanup(sockPath)
    }
  })

  it('two clients connect, server broadcasts to both', async () => {
    const sockPath = tempSocket()
    const clients = new Set()

    const server = net.createServer(client => {
      clients.add(client)
      client.on('data', createMessageReader(msg => {
        const frame = encodeNative(msg)
        for (const c of clients) c.write(frame)
      }))
      client.on('end', () => clients.delete(client))
    })

    await new Promise((resolve, reject) => {
      server.listen(sockPath, resolve)
      server.on('error', reject)
    })

    try {
      // Connect two clients
      const connect = () => new Promise((resolve, reject) => {
        const conn = net.createConnection(sockPath)
        conn.on('connect', () => resolve(conn))
        conn.on('error', reject)
      })

      const [c1, c2] = await Promise.all([connect(), connect()])

      // Collect messages for each client
      const received1 = []
      const received2 = []
      c1.on('data', createMessageReader(msg => received1.push(msg)))
      c2.on('data', createMessageReader(msg => received2.push(msg)))

      // Client 1 sends a message; server broadcasts to both
      const msg = { jsonrpc: '2.0', method: 'broadcast', params: { text: 'hello' } }
      c1.write(encodeNative(msg))

      // Wait for messages to propagate
      await new Promise(resolve => setTimeout(resolve, 100))

      assert.strictEqual(received1.length, 1)
      assert.strictEqual(received2.length, 1)
      assert.deepStrictEqual(received1[0], msg)
      assert.deepStrictEqual(received2[0], msg)

      c1.end()
      c2.end()
    } finally {
      await new Promise(resolve => server.close(resolve))
      cleanup(sockPath)
    }
  })

  it('connection to non-existent socket returns error', async () => {
    const sockPath = tempSocket()

    await assert.rejects(
      () => new Promise((resolve, reject) => {
        const conn = net.createConnection(sockPath)
        conn.on('connect', () => {
          conn.end()
          resolve()
        })
        conn.on('error', reject)
      }),
      err => {
        assert.ok(
          err.code === 'ENOENT' || err.code === 'ECONNREFUSED',
          `Expected ENOENT or ECONNREFUSED, got ${err.code}`
        )
        return true
      }
    )
  })
})
