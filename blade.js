#!/usr/bin/env node
const { startHost } = require('./src/host')
const { startCli } = require('./src/cli')
const { install, uninstall } = require('./src/setup')

const args = process.argv.slice(2)

if (args[0]?.startsWith('chrome-extension://')) {
  startHost()
} else if (args[0] === 'install') {
  install(args[1])
} else if (args[0] === 'uninstall') {
  uninstall()
} else {
  startCli(args)
}
