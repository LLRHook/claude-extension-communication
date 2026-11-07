const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { hostBinaryPath } = require('../src/native')

function fixture(t, { binary = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-install-'))
  const root = path.join(dir, 'package')
  const home = path.join(dir, 'home')
  fs.mkdirSync(root)
  fs.mkdirSync(home)
  const source = path.resolve(__dirname, '..')
  for (const file of ['blade.js', 'package.json', 'src', 'scripts']) {
    fs.cpSync(path.join(source, file), path.join(root, file), { recursive: true })
  }
  if (binary) {
    const destination = path.join(root, 'native', 'bin', path.basename(hostBinaryPath()))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(hostBinaryPath(), destination)
    fs.chmodSync(destination, 0o755)
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { root, home, env: { ...process.env, HOME: home, USERPROFILE: home, npm_config_cache: path.join(dir, 'npm-cache') } }
}

describe('Rust host distribution', () => {
  it('includes native sources, lockfile, build scripts and host in the npm package', t => {
    const { root, env } = fixture(t)
    // List the actual package policy, without invoking prepack/build or publishing.
    const result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', shell: process.platform === 'win32'
    })
    assert.equal(result.status, 0, result.stderr)
    const files = JSON.parse(result.stdout)[0].files.map(file => file.path)
    for (const file of ['blade.js', 'src/host.js', 'scripts/build-host.js', 'scripts/ensure-host.js', 'native/Cargo.toml', 'native/Cargo.lock', 'native/src/main.rs']) {
      assert.ok(files.includes(file), file + ' missing from package')
    }
    assert.ok(files.includes('native/bin/' + path.basename(hostBinaryPath())))
    assert.equal(files.some(file => file.startsWith('native/target/')), false)
    const install = spawnSync(process.execPath, ['scripts/ensure-host.js'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(install.status, 0, install.stderr)
    assert.match(install.stdout, /complete setup/)
  })

  it('installs a working default host launcher in an isolated temporary HOME', { skip: process.platform === 'win32' }, t => {
    const { root, home, env } = fixture(t)
    const result = spawnSync(process.execPath, ['blade.js', 'install', 'a'.repeat(32)], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const manifestPath = process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.blade.bridge.json')
      : path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', 'com.blade.bridge.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    assert.equal(fs.realpathSync(manifest.path), fs.realpathSync(path.join(root, 'blade.js')))
    assert.equal(manifest.type, 'stdio')
    assert.deepEqual(manifest.allowed_origins, ['chrome-extension://' + 'a'.repeat(32) + '/'])
    // No browser/profile or registry access. Empty stdin exercises the launcher's
    // real Rust process and graceful EOF, using only this fixture's temporary dir.
    const launch = spawnSync(process.execPath, ['-e', `
      require('./src/protocol').ipcSocketPath = () => require('path').join(process.env.HOME, 'test.sock')
      process.argv = [process.execPath, 'blade.js', 'chrome-extension://synthetic/']
      require('./blade')
    `], { cwd: root, env, input: '', encoding: 'utf8', timeout: 3000 })
    assert.equal(launch.status, 0, launch.stderr)
    assert.equal(launch.stdout, '')
    assert.equal(fs.existsSync(path.join(home, 'test.sock')), false)
  })

  it('refuses manifest installation and host launch when the Rust binary is missing', { skip: process.platform === 'win32' }, t => {
    const { root, home, env } = fixture(t, { binary: false })
    const result = spawnSync(process.execPath, ['blade.js', 'install', 'a'.repeat(32)], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /npm run build:host/)
    assert.deepEqual(fs.readdirSync(home), [])
    const launch = spawnSync(process.execPath, ['blade.js', 'chrome-extension://synthetic/'], {
      cwd: root, env, input: '', encoding: 'utf8', timeout: 3000
    })
    assert.equal(launch.status, 1)
    assert.match(launch.stderr, /cannot start Rust host.*ENOENT/)
    assert.equal(launch.stdout, '')
  })
})
