const HOST_NAME = 'com.blade.bridge'
let port = null
let backoff = 1000

const handlers = {
  'ping': () => ({ pong: true, timestamp: Date.now() }),
  'tabs.list': (params) => chrome.tabs.query(params || {}),
  'tabs.open': (params) => chrome.tabs.create(params),
  'tabs.close': (params) => chrome.tabs.remove(params.tabId).then(() => ({ ok: true })),

  'tabs.navigate': (params) => chrome.tabs.update(params.tabId, { url: params.url }),

  'tabs.executeScript': (params) => {
    return chrome.scripting.executeScript({
      target: { tabId: params.tabId },
      world: params.world || 'MAIN',
      func: async (code) => {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
        return await new AsyncFunction(code)()
      },
      args: [params.code]
    }).then(results => results[0]?.result)
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

async function handleMessage(msg) {
  const { id, method, params } = msg
  if (id === undefined) return

  const handler = handlers[method]
  if (!handler) {
    port?.postMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
    return
  }

  try {
    const result = await handler(params || {})
    port?.postMessage({ jsonrpc: '2.0', id, result })
  } catch (err) {
    port?.postMessage({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } })
  }
}

function connect() {
  port = chrome.runtime.connectNative(HOST_NAME)

  port.onMessage.addListener(msg => {
    backoff = 1000
    handleMessage(msg)
  })

  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError
    console.warn('Blade: disconnected', error?.message || '')
    port = null
    setTimeout(() => { connect(); backoff = Math.min(backoff * 2, 30000) }, backoff)
  })
}

connect()
