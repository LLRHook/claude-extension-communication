const fs = require('fs')
const path = require('path')
const os = require('os')
const net = require('net')
const readline = require('readline')
const { execSync } = require('child_process')
const { ipcSocketPath } = require('./protocol')

const HOST_NAME = 'com.blade.bridge'
const PROJECT_ROOT = path.resolve(__dirname, '..')

function manifestDir() {
  const home = os.homedir()
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
  if (process.platform === 'linux') return path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts')
  return PROJECT_ROOT
}

function buildManifest(extensionId) {
  const hostPath = process.platform === 'win32'
    ? path.join(PROJECT_ROOT, 'blade.bat')
    : path.join(PROJECT_ROOT, 'blade.js')
  return {
    name: HOST_NAME,
    description: 'Blade CLI Bridge',
    path: hostPath,
    type: 'stdio',
    allowed_origins: ['chrome-extension://' + extensionId + '/']
  }
}

function install(extensionId) {
  if (!extensionId) { console.error('Usage: blade install <extension-id>'); process.exit(1) }

  const manifest = buildManifest(extensionId)
  const dir = manifestDir()
  fs.mkdirSync(dir, { recursive: true })
  const manifestPath = path.join(dir, HOST_NAME + '.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log('Manifest written to', manifestPath)

  if (process.platform === 'win32') {
    const batPath = path.join(PROJECT_ROOT, 'blade.bat')
    fs.writeFileSync(batPath, '@echo off\r\nnode "%~dp0blade.js" %*\r\n')
    console.log('Batch wrapper written to', batPath)
    const regKey = 'HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME
    execSync(`reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: 'pipe' })
    console.log('Registry key set:', regKey)
  } else {
    fs.chmodSync(path.join(PROJECT_ROOT, 'blade.js'), 0o755)
  }

  console.log('Installed. Reload the extension in Chrome to connect.')
}

function uninstall() {
  const dir = manifestDir()
  const manifestPath = path.join(dir, HOST_NAME + '.json')
  try { fs.unlinkSync(manifestPath); console.log('Removed', manifestPath) } catch {}

  if (process.platform === 'win32') {
    const batPath = path.join(PROJECT_ROOT, 'blade.bat')
    try { fs.unlinkSync(batPath); console.log('Removed', batPath) } catch {}
    const regKey = 'HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME
    try { execSync(`reg delete "${regKey}" /f`, { stdio: 'pipe' }); console.log('Removed registry key:', regKey) } catch {}
  }

  console.log('Uninstalled.')
}

function extensionPath() {
  return path.join(PROJECT_ROOT, 'extension')
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try { execSync(`${cmd} ${url}`, { stdio: 'ignore' }) } catch {}
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()) }))
}

async function setup() {
  const extPath = extensionPath()
  console.log('\n--- Blade Bridge Setup ---\n')
  console.log('Step 1: Load the extension in Chrome.\n')
  console.log('  Extension folder:\n')
  console.log('  ' + extPath + '\n')
  console.log('  Opening chrome://extensions ...\n')
  openBrowser('chrome://extensions')
  console.log('  1. Enable "Developer mode" (top-right toggle)')
  console.log('  2. Click "Load unpacked"')
  console.log('  3. Select the folder printed above\n')

  const extId = await ask('Paste the Extension ID here: ')
  if (!extId || extId.length < 20) {
    console.error('Invalid extension ID. Run "blade-bridge setup" to try again.')
    process.exit(1)
  }

  console.log('')
  install(extId)
  console.log('\nStep 2: Go back to Chrome and click the reload icon on Blade Bridge.')
  const ready = await ask('\nDone? Press Enter to test the connection...')

  console.log('\nTesting connection...')
  const ok = await testConnection()
  if (ok) {
    console.log('Connected! Try: blade-bridge tabs.list')
  } else {
    console.log('Could not connect. Run "blade-bridge doctor" to diagnose.')
  }
}

function testConnection() {
  return new Promise(resolve => {
    const conn = net.createConnection(ipcSocketPath())
    const timeout = setTimeout(() => { conn.destroy(); resolve(false) }, 5000)
    conn.on('connect', () => { clearTimeout(timeout); conn.end(); resolve(true) })
    conn.on('error', () => { clearTimeout(timeout); resolve(false) })
  })
}

async function doctor() {
  console.log('\n--- Blade Bridge Doctor ---\n')
  let issues = 0

  // Check 1: Manifest file
  const dir = manifestDir()
  const manifestPath = path.join(dir, HOST_NAME + '.json')
  if (fs.existsSync(manifestPath)) {
    console.log('[OK] Manifest file: ' + manifestPath)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (fs.existsSync(manifest.path)) {
      console.log('[OK] Host binary: ' + manifest.path)
    } else {
      console.log('[FAIL] Host binary not found: ' + manifest.path)
      issues++
    }
    console.log('[INFO] Allowed extension: ' + manifest.allowed_origins[0])
  } else {
    console.log('[FAIL] Manifest file not found. Run "blade-bridge install <id>" or "blade-bridge setup".')
    issues++
  }

  // Check 2: Windows registry
  if (process.platform === 'win32') {
    const regKey = 'HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME
    try {
      execSync(`reg query "${regKey}" /ve`, { stdio: 'pipe' })
      console.log('[OK] Registry key: ' + regKey)
    } catch {
      console.log('[FAIL] Registry key missing: ' + regKey)
      issues++
    }
  }

  // Check 3: IPC socket / host running
  const connected = await testConnection()
  if (connected) {
    console.log('[OK] Host is running (IPC socket reachable)')
  } else {
    console.log('[FAIL] Host not running. Is the Chrome extension active and connected?')
    issues++
  }

  // Check 4: Extension folder exists
  const extPath = extensionPath()
  if (fs.existsSync(path.join(extPath, 'manifest.json'))) {
    console.log('[OK] Extension folder: ' + extPath)
  } else {
    console.log('[FAIL] Extension folder not found: ' + extPath)
    issues++
  }

  console.log('')
  if (issues === 0) {
    console.log('All checks passed.')
  } else {
    console.log(issues + ' issue(s) found. Run "blade-bridge setup" for guided installation.')
  }
}

module.exports = { install, uninstall, setup, doctor, extensionPath }
