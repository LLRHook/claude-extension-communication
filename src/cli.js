const net = require('net')
const readline = require('readline')
const { MAX_HOST_MESSAGE_SIZE, encodeNative, createMessageReader, ipcSocketPath, rpc, isRpcResponse } = require('./protocol')

function startCli(args) {
  const sockPath = ipcSocketPath()
  let pendingId = null
  let rl = null
  let finished = false

  const conn = net.createConnection(sockPath)

  const reader = createMessageReader(msg => {
    if (finished) return
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' ||
        ('id' in msg ? !isRpcResponse(msg) : typeof msg.method !== 'string')) {
      finish(1, 'Protocol error: Invalid JSON-RPC message')
      return
    }
    if (msg.error) console.error('ERROR:', msg.error.message)
    else if (msg.result !== undefined) console.log(JSON.stringify(msg.result, null, 2))
    else if (msg.method) console.log(`[${msg.method}]`, JSON.stringify(msg.params, null, 2))
    if (pendingId !== null && msg.id === pendingId) finish(msg.error ? 1 : 0)
  }, { onError: err => finish(1, 'Protocol error: ' + err.message) })
  conn.on('data', reader)
  conn.on('end', () => {
    reader.end()
    finish(1, pendingId !== null ? 'Host disconnected before responding.' : 'Host disconnected.')
  })
  conn.on('close', () => finish(1, 'Host disconnected.'))

  conn.on('error', err => {
    if (finished) return
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      console.error('Host not running.')
      console.error('')
      console.error('  Possible causes:')
      console.error('  - Chrome extension is not loaded or not active')
      console.error('  - Native messaging host is not installed')
      console.error('')
      console.error('  Run "blade-bridge doctor" to diagnose')
      console.error('  Run "blade-bridge setup" for guided installation')
    } else {
      console.error('Connection error:', err.message)
    }
    finish(1)
  })

  conn.on('connect', () => {
    if (args.length > 0) {
      oneShot(args)
    } else {
      interactive()
    }
  })

  function finish(code, message) {
    if (finished) return
    finished = true
    if (message) console.error(message)
    process.exitCode = code
    rl?.close()
    conn.destroy()
  }

  function send(msg) {
    try { conn.write(encodeNative(msg, MAX_HOST_MESSAGE_SIZE)) } catch (err) {
      finish(1, 'Request error: ' + err.message)
    }
  }

  function parseArgs(method, rest) {
    let params = {}
    if (rest) {
      try { params = JSON.parse(rest) } catch { params = { value: rest } }
    }
    return rpc(method, params)
  }

  function oneShot(args) {
    const msg = parseArgs(args[0], args.slice(1).join(' ') || undefined)
    pendingId = msg.id
    send(msg)
  }

  function interactive() {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'blade> ' })
    rl.prompt()
    rl.on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) { rl.prompt(); return }
      if (trimmed === 'quit' || trimmed === 'exit') { finish(0); return }
      const spaceIdx = trimmed.indexOf(' ')
      const method = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
      const rest = spaceIdx === -1 ? undefined : trimmed.slice(spaceIdx + 1)
      send(parseArgs(method, rest))
      if (!finished) rl.prompt()
    })
    rl.on('close', () => finish(0))
  }
}

module.exports = { startCli }
