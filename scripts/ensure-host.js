const fs = require('fs')
const { hostBinaryPath } = require('../src/native')

if (!fs.existsSync(hostBinaryPath())) require('./build-host')
console.log('Run: blade-bridge install <extension-id> to complete setup')
