const path = require('path')

function hostBinaryPath() {
  return path.resolve(__dirname, '..', 'native', 'bin',
    `blade-host-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`)
}

module.exports = { hostBinaryPath }
