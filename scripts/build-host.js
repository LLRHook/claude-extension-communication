const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { hostBinaryPath } = require('../src/native')

const root = path.resolve(__dirname, '..')
const manifest = path.join(root, 'native', 'Cargo.toml')
// Respect Cargo's standard shared-target override; never download a runtime.
const result = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', manifest], {
  cwd: root, stdio: 'inherit', env: process.env
})
if (result.error || result.status !== 0) {
  console.error('Building the Rust host requires Rust >= 1.85 and Cargo on PATH.')
  process.exit(result.status || 1)
}
const target = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, process.env.CARGO_TARGET_DIR)
  : path.join(root, 'native', 'target')
const built = path.join(target, 'release', 'blade-host' + (process.platform === 'win32' ? '.exe' : ''))
const destination = hostBinaryPath()
fs.mkdirSync(path.dirname(destination), { recursive: true })
fs.copyFileSync(built, destination)
fs.chmodSync(destination, 0o755)
console.error('Built Rust native messaging host for ' + process.platform + '/' + process.arch)
