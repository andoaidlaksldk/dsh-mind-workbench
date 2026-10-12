/*
 * DSH 思维导图工作台 · 应用侧接管桥。
 *
 * 内嵌画布应用内建了「接管模式」扩展点：只要在应用启动前把
 * `window.takeOverApp` 置为 true，并实现 `window.takeOverAppMethods`
 * 的 8 个存取函数，应用就会把内存中的全部状态（导图数据、实例化配置、
 * 语言、本地配置）交给宿主读写，不再使用 localStorage。
 *
 * 本文件即该契约的实现：数据落到工作台自己的服务端接口
 * `/api/dsh-mind-workbench/...`（同源，因此直接带 cookie 请求），
 * 并通过 postMessage 与 DSH 工作台面板通信。
 * 它不修改应用构建产物中的任何业务代码。
 */
(function () {
  'use strict'

  var API = '/api/dsh-mind-workbench'
  var CHANNEL = 'dsh-mind-workbench'
  var SAVE_DELAY = 400
  var PREFERENCE_DELAY = 600

  var state = {
    documentId: null,
    data: null,
    language: 'zh',
    mindMapConfig: null,
    localConfig: null,
    offline: false
  }

  var saveTimer = null
  var preferenceTimer = null
  var pendingPreferences = {}
  var saving = false
  var saveQueued = false
  var dirtyNotified = false

  function fallbackDocument() {
    return {
      root: { data: { text: 'DSH 思维导图' }, children: [] },
      theme: { template: 'avocado', config: {} },
      layout: 'logicalStructure',
      config: {},
      view: null
    }
  }

  function notify(type, detail) {
    var message = { channel: CHANNEL, type: type }
    if (detail) {
      for (var key in detail) {
        if (Object.prototype.hasOwnProperty.call(detail, key)) message[key] = detail[key]
      }
    }
    try {
      window.parent.postMessage(message, window.location.origin)
    } catch (error) {
      /* 宿主不是同源父窗口时忽略，应用自身仍可正常工作 */
    }
  }

  function reportError(scope, error) {
    notify('error', { scope: scope, message: String((error && error.message) || error) })
  }

  function flushSave() {
    if (state.offline || !state.data || !state.documentId) return
    if (saving) {
      saveQueued = true
      return
    }
    saving = true
    fetch(API + '/session/data', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: state.documentId, data: state.data })
    })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (payload) {
        dirtyNotified = false
        notify('saved', { documentId: state.documentId, updatedAt: payload.updatedAt || null })
      })
      .catch(function (error) {
        reportError('save', error)
      })
      .then(function () {
        saving = false
        if (saveQueued) {
          saveQueued = false
          scheduleSave()
        }
      })
  }

  function scheduleSave() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSave, SAVE_DELAY)
  }

  // 有未落盘改动时通知一次宿主，用于面板上的「正在保存」状态与关闭前刷新。
  function markDirty() {
    if (dirtyNotified) return
    dirtyNotified = true
    notify('dirty')
  }

  // 页面隐藏或卸载时用 sendBeacon 尽力补一次落盘：同步 fetch 在卸载阶段不可靠。
  function flushBeacon() {
    if (state.offline || !state.data || !state.documentId) return
    var body = JSON.stringify({ documentId: state.documentId, data: state.data })
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(API + '/session/data', new Blob([body], { type: 'application/json' }))
      else flushSave()
    } catch (error) {
      /* 卸载阶段的尽力而为，失败即放弃 */
    }
  }

  function flushPreferences() {
    if (state.offline) return
    var payload = pendingPreferences
    pendingPreferences = {}
    if (!Object.keys(payload).length) return
    fetch(API + '/session/preferences', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function () {
        notify('preferences-saved')
      })
      .catch(function (error) {
        reportError('preferences', error)
      })
  }

  function schedulePreferences(patch) {
    for (var key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) pendingPreferences[key] = patch[key]
    }
    clearTimeout(preferenceTimer)
    preferenceTimer = setTimeout(flushPreferences, PREFERENCE_DELAY)
  }

  // 接管模式开关必须在应用脚本执行前生效；index.html 的 head 里已置位，
  // 这里再置一次，避免桥被单独引入时行为不一致。
  window.takeOverApp = true

  // 上游在首次打开时会弹「网页版仅供试用，请下载客户端」的提示框。
  // 内置工作台是完整功能，这里预置它自己的去重标志，避免每次新环境都弹一次。
  try {
    if (!window.localStorage.getItem('webUseTip')) window.localStorage.setItem('webUseTip', '1')
  } catch (error) {
    /* localStorage 不可用时忽略，仅表现为多弹一次提示 */
  }

  window.takeOverAppMethods = {
    getMindMapData: function () {
      return state.data
    },
    saveMindMapData: function (data) {
      state.data = data
      markDirty()
      scheduleSave()
    },
    getMindMapConfig: function () {
      return state.mindMapConfig
    },
    saveMindMapConfig: function (config) {
      state.mindMapConfig = config
      schedulePreferences({ mindMapConfig: config })
    },
    getLanguage: function () {
      return state.language
    },
    saveLanguage: function (language) {
      state.language = language
      schedulePreferences({ language: language })
    },
    getLocalConfig: function () {
      return state.localConfig
    },
    saveLocalConfig: function (config) {
      state.localConfig = config
      schedulePreferences({ localConfig: config })
    }
  }

  function boot() {
    return fetch(API + '/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (payload) {
        state.documentId = payload.documentId
        state.data = (payload.document && payload.document.data) || fallbackDocument()
        state.language = payload.language || 'zh'
        state.mindMapConfig = payload.mindMapConfig || null
        state.localConfig = payload.localConfig || null
      })
      .catch(function (error) {
        state.offline = true
        state.documentId = null
        state.data = fallbackDocument()
        reportError('boot', error)
      })
  }

  window.dshMindWorkbench = {
    state: state,
    flush: flushSave,
    reload: function () {
      window.location.reload()
    }
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin) return
    var message = event.data
    if (!message || message.channel !== CHANNEL) return

    if (message.type === 'snapshot') {
      flushSave()
      notify('snapshot', {
        requestId: message.requestId || null,
        documentId: state.documentId,
        data: state.data,
        offline: state.offline
      })
    } else if (message.type === 'flush') {
      flushSave()
    } else if (message.type === 'reload') {
      window.location.reload()
    } else if (message.type === 'command' && typeof message.command === 'string') {
      if (window.$bus && typeof window.$bus.$emit === 'function') {
        window.$bus.$emit('execCommand', message.command)
      }
    }
  })

  window.addEventListener('pagehide', flushBeacon)
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushBeacon()
    })
  }

  // 「教程」等包内文档链接：在画布内以浮层打开。
  // 上游用的是 target="_blank"，在桌面壳里会被 window.open 策略拦掉（点了没反应），
  // 所以这里自己接管，保证一定打得开，而且不丢画布状态。
  var DOC_PREFIX = API + '/app/docs/'

  function openDocOverlay(href) {
    var existing = document.getElementById('dshMindDocOverlay')
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing)

    var overlay = document.createElement('div')
    overlay.id = 'dshMindDocOverlay'
    overlay.setAttribute('style', 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px')

    var panel = document.createElement('div')
    panel.setAttribute('style', 'position:relative;width:100%;max-width:920px;height:100%;max-height:80vh;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.32)')

    var close = document.createElement('button')
    close.type = 'button'
    close.textContent = '关闭'
    close.setAttribute('style', 'position:absolute;top:10px;right:12px;z-index:2;padding:4px 12px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;color:#1f2329;background:#fff;border:1px solid #dcdfe6;border-radius:6px')
    close.onclick = function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
    }

    var frame = document.createElement('iframe')
    frame.src = href
    frame.setAttribute('title', '教程')
    frame.setAttribute('style', 'width:100%;height:100%;border:0;background:#fff')

    panel.appendChild(close)
    panel.appendChild(frame)
    overlay.appendChild(panel)
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
    })
    document.body.appendChild(overlay)
  }

  // 捕获阶段拦截，避免上游的 target="_blank" 先被处理。
  document.addEventListener('click', function (event) {
    var node = event.target
    while (node && node !== document.body) {
      if (node.tagName === 'A') break
      node = node.parentNode
    }
    if (!node || node.tagName !== 'A') return
    var href = node.getAttribute('href') || ''
    if (href.indexOf(DOC_PREFIX) !== 0) return
    event.preventDefault()
    openDocOverlay(href)
  }, true)

  window.onload = function () {
    boot().then(function () {
      if (typeof window.initApp !== 'function') {
        notify('error', { scope: 'boot', message: '应用初始化入口不可用。' })
        return
      }
      if (window.$bus && typeof window.$bus.$on === 'function') {
        window.$bus.$on('app_inited', function (mindMap) {
          window.dshMindWorkbench.mindMap = mindMap
          notify('ready', {
            documentId: state.documentId,
            language: state.language,
            offline: state.offline
          })
        })
      }
      window.initApp()
    })
  }
})()
