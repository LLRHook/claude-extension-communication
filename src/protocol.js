const os = require('os')
const path = require('path')
const { TextDecoder } = require('util')

// Chrome permits 1 MiB from the host and 64 MiB from the extension.
const MAX_HOST_MESSAGE_SIZE = 1024 * 1024
const MAX_EXTENSION_MESSAGE_SIZE = 64 * 1024 * 1024
const littleEndian = os.endianness() === 'LE'
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

let nextId = 1

function messageLength(header, maxMessageSize) {
  const length = littleEndian ? header.readUInt32LE(0) : header.readUInt32BE(0)
  if (length === 0 || length > maxMessageSize) {
    throw new RangeError('Invalid native message length: ' + length)
  }
  return length
}

function parsePayload(payload) {
  return JSON.parse(utf8.decode(payload))
}

function encodeNative(obj, maxMessageSize = MAX_EXTENSION_MESSAGE_SIZE) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  if (payload.length > maxMessageSize) {
    throw new RangeError('Native message exceeds ' + maxMessageSize + ' bytes')
  }
  const header = Buffer.alloc(4)
  if (littleEndian) header.writeUInt32LE(payload.length, 0)
  else header.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, payload])
}

function decodeNative(buffer, maxMessageSize = MAX_EXTENSION_MESSAGE_SIZE) {
  const messages = []
  while (buffer.length >= 4) {
    const len = messageLength(buffer, maxMessageSize)
    if (buffer.length < 4 + len) break
    messages.push(parsePayload(buffer.subarray(4, 4 + len)))
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

function isRpcResponse(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || !('id' in msg)) return false
  if (msg.id !== null && typeof msg.id !== 'string' && !(typeof msg.id === 'number' && Number.isFinite(msg.id))) return false
  if (('result' in msg) === ('error' in msg)) return false
  if ('result' in msg) return true
  return msg.error !== null && typeof msg.error === 'object' && !Array.isArray(msg.error) &&
    Number.isInteger(msg.error.code) && typeof msg.error.message === 'string'
}

function createMessageReader(onMessage, { onError, maxMessageSize = MAX_EXTENSION_MESSAGE_SIZE } = {}) {
  const header = Buffer.alloc(4)
  let headerBytes = 0
  let length = 0
  let payloadBytes = 0
  let payload = null
  let stopped = false

  function fail(error) {
    stopped = true
    payload = null
    if (onError) onError(error)
    else throw error
  }

  function read(chunk) {
    let offset = 0
    while (!stopped && offset < chunk.length) {
      if (headerBytes < 4) {
        const bytes = Math.min(4 - headerBytes, chunk.length - offset)
        chunk.copy(header, headerBytes, offset, offset + bytes)
        headerBytes += bytes
        offset += bytes
        if (headerBytes < 4) return
        try {
          length = messageLength(header, maxMessageSize)
          payload = Buffer.allocUnsafe(length)
        } catch (error) { fail(error); return }
      }

      const bytes = Math.min(length - payloadBytes, chunk.length - offset)
      chunk.copy(payload, payloadBytes, offset, offset + bytes)
      payloadBytes += bytes
      offset += bytes
      if (payloadBytes < length) return

      let message
      try {
        message = parsePayload(payload)
      } catch (error) { fail(error); return }
      headerBytes = 0
      payloadBytes = 0
      payload = null
      onMessage(message)
    }
  }

  read.end = () => {
    if (stopped) return
    if (headerBytes || payloadBytes) fail(new Error('Truncated native message'))
    stopped = true
  }
  return read
}

module.exports = { MAX_HOST_MESSAGE_SIZE, MAX_EXTENSION_MESSAGE_SIZE, encodeNative, decodeNative, createMessageReader, ipcSocketPath, rpc, rpcResult, rpcError, rpcNotify, isRpcResponse }
