const net = require('net')
const fs = require('fs')
const { MAX_HOST_MESSAGE_SIZE, encodeNative, createMessageReader, ipcSocketPath, rpcError, isRpcResponse } = require('./protocol')

function startHost() {
  const sockPath = ipcSocketPath()
  const clients = new Map()
  const pending = new Map()
  let nextRequestId = 1
  let stopping = false
  let retried = false
  let probe = null

  const server = net.createServer(client => {
    const requests = new Set()
    clients.set(client, requests)
    const reader = createMessageReader(msg => {
      if (!isMessage(msg) || typeof msg.method !== 'string' ||
          ('id' in msg && !validId(msg.id)) ||
          ('params' in msg && (msg.params === null || typeof msg.params !== 'object'))) {
        const id = isMessage(msg) && validId(msg.id) ? msg.id : null
        client.write(encodeNative(rpcError(id, -32600, 'Invalid Request')))
        return
      }

      const id = nextRequestId++
      let frame
      try {
        frame = encodeNative('id' in msg ? { ...msg, id } : msg, MAX_HOST_MESSAGE_SIZE)
      } catch {
        client.destroy()
        return
      }
      if ('id' in msg) {
        pending.set(id, { client, id: msg.id })
        requests.add(id)
      }
      process.stdout.write(frame)
    }, { maxMessageSize: MAX_HOST_MESSAGE_SIZE, onError: () => client.destroy() })
    client.on('data', reader)
    client.on('end', () => { reader.end(); client.destroy() })
    client.on('error', () => client.destroy())
    client.on('close', () => {
      clients.delete(client)
      for (const id of requests) pending.delete(id)
      requests.clear()
    })
  })

  server.on('listening', () => {
    if (process.platform !== 'win32') {
      try { fs.chmodSync(sockPath, 0o600) } catch (error) { shutdown(error) }
    }
  })
  server.on('error', error => {
    if (error.code !== 'EADDRINUSE' || process.platform === 'win32' || retried || stopping) {
      shutdown(error)
      return
    }
    // Reclaim stale sockets, but never unlink a socket belonging to a live host.
    retried = true
    probe = net.createConnection(sockPath)
    probe.on('connect', () => { probe.destroy(); shutdown(error) })
    probe.on('error', probeError => {
      if (stopping) return
      if (probeError.code !== 'ECONNREFUSED' && probeError.code !== 'ENOENT') {
        shutdown(probeError)
        return
      }
      try {
        const stat = fs.lstatSync(sockPath)
        if (!stat.isSocket()) { shutdown(error); return }
        fs.unlinkSync(sockPath)
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') { shutdown(unlinkError); return }
      }
      server.listen(sockPath)
    })
  })

  const reader = createMessageReader(msg => {
    if (stopping) return
    if (!isMessage(msg)) { shutdown(new Error('Invalid native message')); return }
    if ('id' in msg) {
      if (!isRpcResponse(msg)) { shutdown(new Error('Invalid native response')); return }
      const request = pending.get(msg.id)
      if (!request) return
      pending.delete(msg.id)
      clients.get(request.client)?.delete(msg.id)
      if (!request.client.destroyed) {
        try { request.client.write(encodeNative({ ...msg, id: request.id })) } catch {
          request.client.destroy()
        }
      }
    } else if (typeof msg.method === 'string') {
      const frame = encodeNative(msg)
      for (const client of clients.keys()) client.write(frame)
    } else {
      shutdown(new Error('Invalid native notification'))
    }
  }, { onError: shutdown })
  process.stdin.on('data', reader)
  process.stdin.on('error', shutdown)
  process.stdout.on('error', shutdown)

  function shutdown(error) {
    if (stopping) return
    stopping = true
    if (error) {
      console.error('Blade host:', error.message)
      process.exitCode = 1
    }
    probe?.destroy()
    process.stdin.removeListener('data', reader)
    process.stdin.destroy()
    for (const client of clients.keys()) client.destroy()
    pending.clear()
    server.close()
  }

  process.stdin.on('end', () => { reader.end(); shutdown() })
  process.on('SIGTERM', () => shutdown())
  process.on('SIGINT', () => shutdown())
  server.listen(sockPath)
}

function isMessage(msg) {
  return msg !== null && typeof msg === 'object' && !Array.isArray(msg) && msg.jsonrpc === '2.0'
}

function validId(id) {
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
}

module.exports = { startHost }
