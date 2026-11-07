const { spawn } = require('child_process')
const { ipcSocketPath } = require('./protocol')
const { hostBinaryPath } = require('./native')

// Node selects the platform binary/socket and inherits Chrome's stdio.
// Framing, validation, routing, IPC lifecycle and bounded writes live in Rust.
function startHost({ socketPath = ipcSocketPath(), writeTimeoutMs = 10000 } = {}) {
  const child = spawn(hostBinaryPath(), [
    '--socket', socketPath, '--write-timeout-ms', String(writeTimeoutMs)
  ], { stdio: 'inherit', windowsHide: true })
  const terminate = () => child.kill('SIGTERM')
  const interrupt = () => child.kill('SIGINT')
  process.on('SIGTERM', terminate)
  process.on('SIGINT', interrupt)
  child.once('error', error => {
    console.error('Blade host: cannot start Rust host (' + error.code + '). Run "npm run build:host" with Rust installed.')
    process.exitCode = 1
  })
  child.once('close', (code, signal) => {
    process.removeListener('SIGTERM', terminate)
    process.removeListener('SIGINT', interrupt)
    process.exitCode = !signal && Number.isInteger(code) && code >= 0 ? code : 1
  })
  return child
}

module.exports = { startHost }
