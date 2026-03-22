const net = require('net')
const readline = require('readline')
const { encodeNative, createMessageReader, ipcSocketPath, rpc } = require('./protocol')

function startCli(args) {
  const sockPath = ipcSocketPath()
  let pendingId = null

  const conn = net.createConnection(sockPath)

  conn.on('data', createMessageReader(msg => {
    if (msg.error) console.error('ERROR:', msg.error.message)
    else if (msg.result !== undefined) console.log(JSON.stringify(msg.result, null, 2))
    else if (msg.method) console.log(`[${msg.method}]`, JSON.stringify(msg.params, null, 2))
    if (pendingId !== null && msg.id === pendingId) { conn.end(); process.exit(0) }
  }))

  conn.on('error', err => {
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
    process.exit(1)
  })

  conn.on('connect', () => {
    if (args.length > 0) {
      oneShot(conn, args)
    } else {
      interactive(conn)
    }
  })

  function parseArgs(method, rest) {
    let params = {}
    if (rest) {
      try { params = JSON.parse(rest) } catch { params = { value: rest } }
    }
    return rpc(method, params)
  }

  function oneShot(conn, args) {
    const msg = parseArgs(args[0], args.slice(1).join(' ') || undefined)
    pendingId = msg.id
    conn.write(encodeNative(msg))
  }

  function interactive(conn) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'blade> ' })
    rl.prompt()
    rl.on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) { rl.prompt(); return }
      if (trimmed === 'quit' || trimmed === 'exit') { conn.end(); process.exit(0) }
      const spaceIdx = trimmed.indexOf(' ')
      const method = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
      const rest = spaceIdx === -1 ? undefined : trimmed.slice(spaceIdx + 1)
      conn.write(encodeNative(parseArgs(method, rest)))
      rl.prompt()
    })
    rl.on('close', () => { conn.end(); process.exit(0) })
  }
}

module.exports = { startCli }
