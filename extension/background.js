const HOST_NAME = 'com.blade.bridge'
let port = null
let backoff = 1000
const attachedTabs = new Set()

// Clean up debugger when tabs close or debugger detaches
chrome.debugger.onDetach.addListener((source) => {
  attachedTabs.delete(source.tabId)
})
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId)
})

const handlers = {
  'ping': () => ({ pong: true, timestamp: Date.now() }),
  'tabs.list': (params) => chrome.tabs.query(params || {}),
  'tabs.open': (params) => chrome.tabs.create(params),
  'tabs.close': (params) => chrome.tabs.remove(params.tabId).then(() => ({ ok: true })),

  'tabs.navigate': (params) => chrome.tabs.update(params.tabId, { url: params.url }),

  'tabs.executeScript': async (params) => {
    const tabId = params.tabId
    if (!attachedTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, '1.3')
      attachedTabs.add(tabId)
    }
    const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(async () => { ${params.code} })()`,
      returnByValue: true,
      awaitPromise: true
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || 'Script execution error')
    }
    return res.result?.value
  },

  'tabs.detachDebugger': async (params) => {
    const tabId = params.tabId
    if (attachedTabs.has(tabId)) {
      await chrome.debugger.detach({ tabId }).catch(() => {})
      attachedTabs.delete(tabId)
    }
    return { ok: true }
  },

  'tabs.waitForLoad': (params) => new Promise((resolve, reject) => {
    const timeout = params.timeout || 15000
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error('Tab load timeout'))
    }, timeout)

    function listener(tabId, info) {
      if (tabId === params.tabId && info.status === 'complete') {
        clearTimeout(timer)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve({ ok: true })
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
  }),

  'tabs.screenshot': (params) => chrome.tabs.captureVisibleTab(
    params.windowId || chrome.windows.WINDOW_ID_CURRENT,
    { format: params.format || 'png' }
  ),

  'extension.getPopupUrl': (params) => ({
    url: `chrome-extension://${params.extensionId}/${params.popup || 'popup.html'}`
  })
}

function postResponse(sourcePort, message) {
  if (port !== sourcePort) return
  try { sourcePort.postMessage(message) } catch (err) {
    console.warn('Blade: could not send response', err.message)
  }
}

function validId(id) {
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
}

async function handleMessage(msg, sourcePort) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg) ||
      msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' ||
      ('id' in msg && !validId(msg.id)) ||
      ('params' in msg && (msg.params === null || typeof msg.params !== 'object'))) {
    const id = msg && typeof msg === 'object' && validId(msg.id) ? msg.id : null
    postResponse(sourcePort, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } })
    return
  }

  const { id, method, params } = msg
  const respond = message => { if ('id' in msg) postResponse(sourcePort, message) }

  const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined
  if (!handler) {
    respond({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
    return
  }

  try {
    const result = await handler(params || {})
    respond({ jsonrpc: '2.0', id, result: result === undefined ? null : result })
  } catch (err) {
    respond({ jsonrpc: '2.0', id, error: { code: -32000, message: err?.message || String(err) } })
  }
}

function connect() {
  const nativePort = chrome.runtime.connectNative(HOST_NAME)
  port = nativePort

  nativePort.onMessage.addListener(msg => {
    if (port !== nativePort) return
    backoff = 1000
    handleMessage(msg, nativePort)
  })

  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError
    if (port !== nativePort) return
    console.warn('Blade: disconnected', error?.message || '')
    port = null
    setTimeout(() => { connect(); backoff = Math.min(backoff * 2, 30000) }, backoff)
  })
}

connect()
