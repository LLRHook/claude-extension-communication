const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')

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

module.exports = { install, uninstall }
