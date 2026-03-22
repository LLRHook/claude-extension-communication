const os = require('os')
const path = require('path')

let nextId = 1

function encodeNative(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length, 0)
  return Buffer.concat([header, payload])
}

function decodeNative(buffer) {
  const messages = []
  while (buffer.length >= 4) {
    const len = buffer.readUInt32LE(0)
    if (buffer.length < 4 + len) break
    messages.push(JSON.parse(buffer.subarray(4, 4 + len).toString('utf8')))
    buffer = buffer.subarray(4 + len)
  }
  return { messages, remainder: buffer }
}

function ipcSocketPath() {
  const user = os.userInfo().username
  if (process.platform === 'win32') return '\\\\.\\pipe\\blade-bridge-' + user
  return path.join(os.tmpdir(), 'blade-bridge-' + user + '.sock')
}

function rpc(method, params = {}) {
  return { jsonrpc: '2.0', id: nextId++, method, params }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function rpcNotify(method, params = {}) {
  return { jsonrpc: '2.0', method, params }
}

function createMessageReader(onMessage) {
  let buf = Buffer.alloc(0)
  return chunk => {
    buf = Buffer.concat([buf, chunk])
    const { messages, remainder } = decodeNative(buf)
    buf = remainder
    messages.forEach(onMessage)
  }
}

module.exports = { encodeNative, decodeNative, createMessageReader, ipcSocketPath, rpc, rpcResult, rpcError, rpcNotify }
