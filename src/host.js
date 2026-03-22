const net = require('net')
const fs = require('fs')
const { encodeNative, createMessageReader, ipcSocketPath } = require('./protocol')

function startHost() {
  const sockPath = ipcSocketPath()
  const clients = new Set()

  if (process.platform !== 'win32') {
    try { fs.unlinkSync(sockPath) } catch {}
  }

  const server = net.createServer(client => {
    clients.add(client)
    client.on('data', createMessageReader(msg => process.stdout.write(encodeNative(msg))))
    client.on('end', () => clients.delete(client))
    client.on('error', () => clients.delete(client))
  })

  server.listen(sockPath)

  process.stdin.on('data', createMessageReader(msg => {
    const frame = encodeNative(msg)
    for (const c of clients) c.write(frame)
  }))

  function shutdown() {
    for (const c of clients) c.end()
    server.close()
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(sockPath) } catch {}
    }
  }

  process.stdin.on('end', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

module.exports = { startHost }
