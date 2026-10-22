const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { encodeNative, createMessageReader } = require('../src/protocol')

async function runCli(t, handleClient, args = ['ping']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-cli-'))
  const sockPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\blade-cli-' + path.basename(dir)
    : path.join(dir, 'bridge.sock')
  const clients = new Set()
  const server = net.createServer(client => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    handleClient(client)
  })
  t.after(async () => {
    for (const client of clients) client.destroy()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  server.listen(sockPath)
  await once(server, 'listening')

  const script = `
    require('./src/protocol').ipcSocketPath = () => process.argv[1]
    require('./src/cli').startCli(process.argv.slice(2))
  `
  const child = spawn(process.execPath, ['-e', script, sockPath, ...args], {
    cwd: path.resolve(__dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const closed = once(child, 'close')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.on('error', () => {})
  t.after(async () => { child.kill(); await closed })
  const [code] = await closed
  return { code, stdout, stderr }
}

describe('CLI outcomes', () => {
  it('prints a complete successful response before exiting', { timeout: 5000 }, async t => {
    const result = 'x'.repeat(128 * 1024)
    const cli = await runCli(t, client => {
      client.on('data', createMessageReader(msg => {
        client.write(encodeNative({ jsonrpc: '2.0', id: msg.id, result }))
      }))
    })
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(JSON.parse(cli.stdout), result)
  })

  it('exits unsuccessfully for a JSON-RPC error response', { timeout: 5000 }, async t => {
    const cli = await runCli(t, client => {
      client.on('data', createMessageReader(msg => {
        client.write(encodeNative({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }))
      }))
    })
    assert.equal(cli.code, 1)
    assert.match(cli.stderr, /Method not found/)
  })

  it('reports host disconnection before a one-shot response', { timeout: 5000 }, async t => {
    const cli = await runCli(t, client => {
      client.on('data', () => client.end())
    })
    assert.equal(cli.code, 1)
    assert.match(cli.stderr, /disconnected.*respond/i)
  })

  it('closes the interactive prompt if the host disconnects', { timeout: 5000 }, async t => {
    const cli = await runCli(t, client => client.end(), [])
    assert.equal(cli.code, 1)
    assert.match(cli.stderr, /disconnected/i)
  })

  it('reports malformed host frames without an uncaught exception', { timeout: 5000 }, async t => {
    const cli = await runCli(t, client => {
      client.on('data', () => client.write(Buffer.alloc(4)))
    })
    assert.equal(cli.code, 1)
    assert.match(cli.stderr, /Protocol error/)
    assert.doesNotMatch(cli.stderr, /at .*src\/protocol\.js/)
  })

  it('rejects response envelopes missing both result and error', { timeout: 5000 }, async t => {
    const cli = await runCli(t, client => {
      client.on('data', createMessageReader(msg => {
        client.write(encodeNative({ jsonrpc: '2.0', id: msg.id }))
      }))
    })
    assert.equal(cli.code, 1)
    assert.match(cli.stderr, /Protocol error/)
  })
})
