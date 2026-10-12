/**
 * DSH 思维导图工作台 · 客户端入口（已构建的单文件模块）。
 *
 * 加载协议：window.__ModuleLoader__.load({ id, factory })，与仓库内其他插件一致。
 * 职责划分：
 *   - 样式        installStyles()
 *   - 文案        ctx.locale.register(NS, { zh, en })
 *   - 接口调用    callApi()（集中在插件请求函数里，不散落在展示组件中）
 *   - 桥接协议    CHANNEL / postMessage（与 app/bridge.js 对称）
 *   - 界面        工具栏 + 画布（内嵌应用）+ 原生会话停靠区
 *
 * 关于内嵌方式：工作台规范要求业务面板是一个 React 组件，宿主不提供 iframe
 * 容器、也禁止 <webview>；上游画布是 Vue2 + ElementUI 的独立 Web 应用。
 * 为「完整保留全部核心功能」（50 个 Vue 页面、上百个主题、全部导出格式），
 * 这里不再重写业务代码，而是把上游构建产物原样托管在自己同源的路由下，
 * 用 iframe 承载，并通过上游内建的「接管模式」把数据存取接进 DSH：
 * 画布与 DSH 渲染进程同源，因此不需要任何跨源豁免或额外权限。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mind-workbench',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-mind-workbench'
    const API = '/api/dsh-mind-workbench'
    const APP_URL = `${API}/app/index.html`
    const CHANNEL = 'dsh-mind-workbench'
    const REPOSITORY = 'https://github.com/dataelement/dsh-mind-workbench'
    const SNAPSHOT_TIMEOUT_MS = 5000
    const FIRST_USE_HINT_KEY = 'dsh-mind-workbench.first-use-hint.v1'
    // 轮询文档列表以发现「画布之外的写入」（例如 Agent 调用 mindmap_write）。
    // 只提示、不自动重载：自动重载会在画布自己保存的瞬间误判并丢掉用户正在编辑的内容。
    const EXTERNAL_POLL_MS = 4000

    // ---------------------------------------------------------------- 样式 ----

    const css = `
.dshMw{position:relative;display:flex;flex-direction:column;flex:1 1 auto;width:100%;height:100%;min-width:0;min-height:0;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshMwToolbar{box-sizing:border-box;display:flex;align-items:center;gap:8px;flex:0 0 auto;min-height:48px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);overflow:hidden}
.dshMwBrand{display:flex;align-items:center;gap:8px;flex:0 0 auto;font-size:14px;line-height:22px;font-weight:600;white-space:nowrap}
.dshMwBrandMark{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;background:var(--dsw-alias-state-business-primary);color:#fff;font-size:12px;font-weight:700}
.dshMwGroup{display:flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0}
.dshMwSpacer{flex:1 1 auto;min-width:4px}
.dshMwSelect{max-width:min(260px,34vw);min-width:96px;padding:5px 8px;font:inherit;font-size:12px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);box-sizing:border-box}
.dshMwSelect:focus-visible,.dshMwBtn:focus-visible,.dshMwInput:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dshMwBtn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;font:inherit;font-size:12px;line-height:20px;white-space:nowrap;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);box-sizing:border-box}
.dshMwBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshMwBtn:disabled{cursor:default;opacity:.5}
.dshMwBtn[data-variant=primary]{color:#fff;background:var(--dsw-alias-state-business-primary);border-color:transparent}
.dshMwBtn[data-variant=primary]:hover:not(:disabled){filter:brightness(1.06)}
.dshMwBtn[data-variant=ghost]{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.dshMwBtn[data-variant=ghost]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshMwBtn[data-variant=danger]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent)}
.dshMwStatus{display:flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;padding:0 2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshMwStatus[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.dshMwDot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.dshMwDot[data-state=ready]{background:var(--dsw-alias-state-business-primary)}
.dshMwDot[data-state=saving]{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
.dshMwDot[data-state=offline]{background:var(--dsw-alias-state-error-primary)}
.dshMwWarn{flex:0 0 auto;padding:7px 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 26%,transparent)}
.dshMwBody{display:flex;flex:1 1 auto;min-width:0;min-height:0}
.dshMwCanvas{position:relative;flex:1 1 auto;min-width:0;min-height:0;display:flex}
.dshMwFrameWrap{position:relative;flex:1 1 auto;min-width:0;min-height:0;display:flex;background:var(--dsw-alias-bg-module-platform)}
.dshMwFrame{flex:1 1 auto;width:100%;height:100%;min-width:0;min-height:0;border:0;display:block;background:#fff}
.dshMwFrame[hidden]{display:none}
.dshMwOverlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.dshMwOverlay strong{font-size:14px;color:var(--dsw-alias-label-primary)}
.dshMwDock{flex:0 0 auto;display:flex;flex-direction:column;width:min(400px,40%);min-width:260px;min-height:0;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dshMwDockFill{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0}
.dshMwFill[hidden],.dshMwHint[hidden],.dshMwDock[hidden]{display:none!important}
.dshMwSession{display:flex;flex-direction:column;gap:12px;padding:18px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow:auto}
.dshMwSession h2{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dshMwSession p{margin:0}
.dshMwSessionRow{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dshMwHint{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:6px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-top:1px solid var(--dsw-alias-border-l2)}
.dshMwHint span:first-child{flex:1 1 auto;min-width:0}
.dshMwModalBackdrop{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:20px;background:color-mix(in srgb,#000 42%,transparent)}
.dshMwModal{width:min(420px,100%);box-sizing:border-box;padding:20px;border-radius:14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 18px 52px rgba(0,0,0,.24);display:flex;flex-direction:column;gap:12px}
.dshMwModal h2{margin:0;font-size:15px;line-height:24px}
.dshMwModal p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshMwInput{width:100%;box-sizing:border-box;padding:8px 10px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.dshMwModalActions{display:flex;justify-content:flex-end;gap:8px}
.dshMwHidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:900px){.dshMwDock{width:100%;min-width:0;border-left:0;border-top:1px solid var(--dsw-alias-border-l2);max-height:42%}.dshMwBody{flex-direction:column}.dshMwSelect{max-width:auto}}
@media(prefers-reduced-motion:reduce){.dshMwBtn,.dshMwSelect{transition:none}}
`

    function installStyles() {
      const existing = document.querySelector('style[data-plugin-css="dsh-mind-workbench"]')
      if (existing) {
        if (existing.textContent !== css) existing.textContent = css
        return
      }
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-mind-workbench'
      style.dataset.pluginCss = 'dsh-mind-workbench'
      style.textContent = css
      document.head.appendChild(style)
    }

    // ---------------------------------------------------------------- 文案 ----

    const zh = {
      title: 'DSH 思维导图',
      panelTitle: '思维导图工作台',
      description: '在工作台里创建、编辑和导出思维导图，数据直接保存在 DSH 数据目录。',
      category: '效率工具',
      document: '文档',
      newDocument: '新建',
      openDocument: '打开',
      rename: '重命名',
      duplicate: '创建副本',
      remove: '删除',
      importDocument: '导入 JSON',
      exportDocument: '导出 JSON',
      saveNow: '立即保存',
      reload: '重新载入画布',
      session: 'AI 协助',
      aiAssist: 'AI 协助',
      aiAssistOn: '收起 AI 协助',
      statusLoading: '正在载入…',
      statusReady: '已连接导图应用',
      statusSaving: '正在保存…',
      statusSaved: '已保存',
      statusOffline: '离线：无法读写 DSH 数据目录，画布改动不会保存',
      bootError: '思维导图应用未能载入。',
      serverMissing: '服务端插件未加载：请在 DSH Desktop 的菜单中选择「重启 Harness」，然后点重试。',
      retry: '重试',
      createTitle: '新建思维导图',
      createLabel: '名称',
      createConfirm: '创建',
      renameTitle: '重命名思维导图',
      renameConfirm: '保存',
      deleteTitle: '删除思维导图',
      deleteBody: '删除后无法恢复。文档文件会从 DSH 数据目录中移除。',
      deleteConfirm: '删除',
      cancel: '取消',
      busy: '处理中…',
      dialogRequired: '名称不能为空。',
      sessionSetupTitle: 'AI 协助',
      sessionSetupBody: '思维导图不依赖会话，画布、主题与导出都可直接使用。需要让 Agent 参与梳理、扩写或校对时，先创建一个关联本工作台的会话。',
      workspaceLabel: '工作区',
      newWorkspaceSession: '选择资料位置并开始会话',
      useWorkspace: '在此工作区开始会话',
      noWorkspace: '还没有可用工作区，请先选择资料位置新建一个。',
      firstUseHint: '画布、主题与导出都无需会话；要让 Agent 参与时点右上角「AI 协助」。',
      externalUpdate: '当前导图已被外部更新（例如 Agent 写入）。',
      dismiss: '不再提示',
      noDocuments: '还没有文档',
      exportFailed: '导出失败：画布没有响应。',
      importInvalid: '导入失败：文件不是合法的导图 JSON。',
      defaultName: '未命名导图',
      modelConfig: '模型配置',
      modelConfigTitle: '模型配置（画布 AI）',
      modelConfigHint: '画布的 AI 一键生成与对话通过本工作台转发到你选择的供应商；密钥只存在本机。',
      provider: '供应商',
      providerCustom: '自定义（OpenAI 兼容）',
      baseUrl: '接口地址',
      baseUrlPlaceholder: 'https://api.deepseek.com/v1',
      apiKey: 'API Key',
      modelName: '模型名',
      modelPlaceholder: 'deepseek-chat',
      save: '保存',
      test: '测试连接',
      testing: '正在测试…',
      saveOk: '模型配置已保存',
      testOk: '连接成功',
      testFail: '连接失败',
      close: '关闭'
    }

    const en = {
      title: 'DSH Mind Workbench',
      panelTitle: 'Mind map workbench',
      description: 'Create, edit and export mind maps inside the workbench; documents are stored in the DSH data directory.',
      category: 'Productivity',
      document: 'Document',
      newDocument: 'New',
      openDocument: 'Open',
      rename: 'Rename',
      duplicate: 'Duplicate',
      remove: 'Delete',
      importDocument: 'Import JSON',
      exportDocument: 'Export JSON',
      saveNow: 'Save now',
      reload: 'Reload canvas',
      session: 'AI assistance',
      aiAssist: 'AI assistance',
      aiAssistOn: 'Hide AI assistance',
      statusLoading: 'Loading…',
      statusReady: 'Canvas connected',
      statusSaving: 'Saving…',
      statusSaved: 'Saved',
      statusOffline: 'Offline: cannot read or write the DSH data directory; changes are not saved',
      bootError: 'The mind map application could not be loaded.',
      serverMissing: 'The server-side plugin is not loaded. Choose “Restart Harness” in the DSH Desktop menu, then retry.',
      retry: 'Retry',
      createTitle: 'New mind map',
      createLabel: 'Name',
      createConfirm: 'Create',
      renameTitle: 'Rename mind map',
      renameConfirm: 'Save',
      deleteTitle: 'Delete mind map',
      deleteBody: 'This cannot be undone. The document file is removed from the DSH data directory.',
      deleteConfirm: 'Delete',
      cancel: 'Cancel',
      busy: 'Working…',
      dialogRequired: 'A name is required.',
      sessionSetupTitle: 'AI assistance',
      sessionSetupBody: 'The mind map does not need a conversation — canvas, themes and export all work directly. To let the agent help with outlining, expanding or proofreading, create a conversation bound to this workbench first.',
      workspaceLabel: 'Workspace',
      newWorkspaceSession: 'Choose a location and start chatting',
      useWorkspace: 'Start a conversation here',
      noWorkspace: 'No workspace yet — choose a location to create one first.',
      firstUseHint: 'Canvas, themes and export need no conversation; use “AI assistance” in the toolbar to involve the agent.',
      externalUpdate: 'This map was updated outside the canvas (for example by the agent).',
      dismiss: 'Don\u2019t show again',
      noDocuments: 'No documents yet',
      exportFailed: 'Export failed: the canvas did not respond.',
      importInvalid: 'Import failed: the file is not a valid mind map JSON.',
      defaultName: 'Untitled map',
      modelConfig: 'Model settings',
      modelConfigTitle: 'Model settings (canvas AI)',
      modelConfigHint: 'The canvas AI features are proxied by this workbench to the provider you pick; the key stays on this machine.',
      provider: 'Provider',
      providerCustom: 'Custom (OpenAI compatible)',
      baseUrl: 'Base URL',
      baseUrlPlaceholder: 'https://api.deepseek.com/v1',
      apiKey: 'API key',
      modelName: 'Model',
      modelPlaceholder: 'deepseek-chat',
      save: 'Save',
      test: 'Test connection',
      testing: 'Testing…',
      saveOk: 'Model settings saved',
      testOk: 'Connection succeeded',
      testFail: 'Connection failed',
      close: 'Close'
    }

    // ---------------------------------------------------------------- 接口 ----

    async function callApi(path, init) {
      const response = await fetch(`${API}/${path}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init
      })
      const contentType = response.headers.get('content-type') || ''
      const payload = contentType.includes('application/json')
        ? await response.json().catch(() => null)
        : null
      if (!response.ok) {
        const error = new Error((payload && payload.error) || `HTTP ${response.status}`)
        // 404 表示本插件的服务端路由没挂上（最常见原因：装好工作台后没有重启 Harness）。
        // 保留状态码，让界面给出可操作的提示，而不是只显示 HTTP 404。
        error.status = response.status
        throw error
      }
      return payload
    }

    const readDocuments = () => callApi('documents')
    const writeDocuments = (body) => callApi('documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

    // ------------------------------------------------------------ 模型配置 ----

    const readModelProviders = () => callApi('ai/providers')
    const readModelSettings = () => callApi('ai/settings')
    const writeModelSettings = (body) => callApi('ai/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const testModel = () => callApi('ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 只索取 1 个 token：够判断地址/密钥/模型名是否可用，又不真正消耗额度。
      body: JSON.stringify({ data: { messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: true } })
    })

    /** 404 说明本插件的服务端路由没挂上（最常见原因：装好工作台后没重启 Harness）。 */
    function describeApiError(t, error) {
      if (error && error.status === 404) return t('serverMissing')
      return (error && error.message) || String(error)
    }

    /**
     * 画布 AI 的模型配置：选供应商 → 填接口地址 / API Key / 模型名。
     * 画布的 AI 请求会经本工作台转发到这家的 OpenAI 兼容接口，密钥只落在本机数据目录。
     */
    function ModelConfigDialog({ t, onClose }) {
      const [providers, setProviders] = React.useState([])
      const [form, setForm] = React.useState({ providerId: '', baseUrl: '', apiKey: '', model: '' })
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [tone, setTone] = React.useState('')

      React.useEffect(() => {
        let cancelled = false
        Promise.all([readModelProviders(), readModelSettings()])
          .then(([providerPayload, settings]) => {
            if (cancelled) return
            setProviders(Array.isArray(providerPayload?.providers) ? providerPayload.providers : [])
            setForm({
              providerId: settings?.providerId || '',
              baseUrl: settings?.baseUrl || '',
              apiKey: settings?.apiKey || '',
              model: settings?.model || ''
            })
          })
          .catch((error) => {
            if (cancelled) return
            setTone('error')
            setMessage(describeApiError(t, error))
          })
        return () => { cancelled = true }
      }, [t])

      const update = (patch) => setForm((current) => ({ ...current, ...patch }))

      const pickProvider = (id) => {
        const preset = providers.find((item) => item.id === id)
        setForm((current) => ({
          ...current,
          providerId: id,
          baseUrl: preset ? preset.baseUrl || '' : current.baseUrl,
          model: preset ? preset.model || '' : current.model
        }))
      }

      const save = () => {
        setBusy(true)
        setTone('')
        setMessage('')
        return writeModelSettings(form)
          .then(() => {
            setTone('ok')
            setMessage(t('saveOk'))
          })
          .catch((error) => {
            setTone('error')
            setMessage(describeApiError(t, error))
          })
          .then(() => { setBusy(false) })
      }

      const test = () => {
        setBusy(true)
        setTone('')
        setMessage(t('testing'))
        // 先落盘再实测：代理读的是已保存的配置，否则测的还是旧值。
        // callApi 在非 2xx 时抛错，因此成功即代表上游接受了这次请求。
        writeModelSettings(form)
          .then(testModel)
          .then(() => {
            setTone('ok')
            setMessage(t('testOk'))
          })
          .catch((error) => {
            setTone('error')
            setMessage(`${t('testFail')}：${describeApiError(t, error)}`)
          })
          .then(() => { setBusy(false) })
      }

      const field = (label, key, options = {}) => h('label', {
        style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' }
      },
      h('span', null, label),
      key === 'providerId'
        ? h('select', {
          className: 'dshMwSelect',
          style: { maxWidth: 'none', width: '100%' },
          value: form.providerId,
          disabled: busy,
          onChange: (event) => pickProvider(event.target.value)
        }, [h('option', { key: '__custom', value: '' }, t('providerCustom'))].concat(
          providers.map((item) => h('option', { key: item.id, value: item.id }, item.name))
        ))
        : h('input', {
          className: 'dshMwInput',
          type: options.password ? 'password' : 'text',
          value: form[key],
          placeholder: options.placeholder || '',
          disabled: busy,
          autoComplete: 'off',
          onChange: (event) => update({ [key]: event.target.value })
        }))

      return h('div', {
        className: 'dshMwModalBackdrop',
        onClick: (event) => { if (event.target === event.currentTarget && !busy) onClose() }
      },
      h('div', {
        className: 'dshMwModal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('modelConfigTitle')
      },
      h('h2', null, t('modelConfigTitle')),
      h('p', null, t('modelConfigHint')),
      field(t('provider'), 'providerId'),
      field(t('baseUrl'), 'baseUrl', { placeholder: t('baseUrlPlaceholder') }),
      field(t('apiKey'), 'apiKey', { password: true }),
      field(t('modelName'), 'model', { placeholder: t('modelPlaceholder') }),
      message
        ? h('p', {
          role: 'status',
          'data-tone': tone,
          style: tone === 'error' ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined
        }, message)
        : null,
      h('div', { className: 'dshMwModalActions' },
        h('button', { type: 'button', className: 'dshMwBtn', disabled: busy, onClick: onClose }, t('close')),
        h('button', { type: 'button', className: 'dshMwBtn', disabled: busy, onClick: test }, busy ? t('testing') : t('test')),
        h('button', { type: 'button', className: 'dshMwBtn', 'data-variant': 'primary', disabled: busy, onClick: save }, t('save')))
      ))
    }

    function downloadJson(fileName, value) {
      const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    }

    function formatClock(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleTimeString()
    }

    // ---------------------------------------------------------------- 对话框 ----

    function Dialog({ title, description, label, initialValue, confirmText, cancelText, tone, busy, onConfirm, onCancel }) {
      const [value, setValue] = React.useState(initialValue || '')
      const [error, setError] = React.useState('')
      const inputRef = React.useRef(null)
      const dialogRef = React.useRef(null)

      React.useEffect(() => {
        if (inputRef.current) inputRef.current.focus()
        else dialogRef.current?.focus()
      }, [])

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation()
            onCancel()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [busy, onCancel])

      const submit = (event) => {
        event.preventDefault()
        if (busy) return
        if (label && !value.trim()) {
          setError('required')
          return
        }
        setError('')
        onConfirm(label ? value.trim() : undefined)
      }

      return h('div', {
        className: 'dshMwModalBackdrop',
        onClick: (event) => { if (event.target === event.currentTarget && !busy) onCancel() }
      },
      h('div', {
        className: 'dshMwModal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        tabIndex: -1,
        ref: dialogRef
      },
      h('form', { onSubmit: submit, style: { display: 'contents' } },
        h('h2', null, title),
        description ? h('p', null, description) : null,
        label ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' } },
          h('span', null, label),
          h('input', {
            className: 'dshMwInput',
            ref: inputRef,
            value,
            maxLength: 120,
            disabled: busy,
            'aria-invalid': error ? 'true' : undefined,
            onChange: (event) => setValue(event.target.value)
          })
        ) : null,
        error ? h('p', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)' } }, 'required') : null,
        h('div', { className: 'dshMwModalActions' },
          h('button', { type: 'button', className: 'dshMwBtn', disabled: busy, onClick: onCancel }, cancelText),
          h('button', {
            type: 'submit',
            className: 'dshMwBtn',
            'data-variant': tone === 'danger' ? 'danger' : 'primary',
            disabled: busy
          }, confirmText)
        )
      ))
      )
    }

    // ------------------------------------------------------------ 工作台面板 ----

    function createPanel(t) {
      return function MindWorkbenchPanel({ service, entry, active, conversation }) {
        const [status, setStatus] = React.useState('loading')
        const [errorText, setErrorText] = React.useState('')
        const [notice, setNotice] = React.useState('')
        const [documents, setDocuments] = React.useState([])
        const [activeDocumentId, setActiveDocumentId] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [dialog, setDialog] = React.useState(null)
        const [reloadToken, setReloadToken] = React.useState(0)
        const [dirty, setDirty] = React.useState(false)
        const [savedAt, setSavedAt] = React.useState('')
        const [offline, setOffline] = React.useState(false)
        const [canvasReady, setCanvasReady] = React.useState(false)
        // 规范 4.1：customFrame 工作台不常驻会话区，只有用户主动选择 AI 协助时才显示。
        const [assist, setAssist] = React.useState(false)
        const [modelOpen, setModelOpen] = React.useState(false)
        // 画布之外的写入（例如 Agent 调 mindmap_write）只会改磁盘：轮询发现后提示重载，
        // 不自动重载，避免在画布自己保存的瞬间误判。
        const [externalStale, setExternalStale] = React.useState(false)
        const seenUpdatedAtRef = React.useRef('')
        const [hintVisible, setHintVisible] = React.useState(() => {
          try { return window.localStorage?.getItem(FIRST_USE_HINT_KEY) !== 'seen' } catch { return true }
        })
        const [workspaceList, setWorkspaceList] = React.useState([])
        const [workspaceId, setWorkspaceId] = React.useState('')

        const frameRef = React.useRef(null)
        const importRef = React.useRef(null)
        const snapshotRef = React.useRef({ counter: 0, pending: new Map() })

        const requestId = React.useCallback(() => {
          const store = snapshotRef.current
          store.counter += 1
          return `snapshot-${store.counter}`
        }, [])

        const message = React.useCallback((payload) => {
          const frame = frameRef.current
          if (!frame || !frame.contentWindow) return
          try {
            frame.contentWindow.postMessage({ channel: CHANNEL, ...payload }, window.location.origin)
          } catch {
            /* 画布尚未就绪时忽略 */
          }
        }, [])

        const refreshDocuments = React.useCallback(async (options = {}) => {
          const payload = await readDocuments()
          setDocuments(Array.isArray(payload?.documents) ? payload.documents : [])
          if (payload?.activeDocumentId) setActiveDocumentId(payload.activeDocumentId)
          if (options.reload) setReloadToken((token) => token + 1)
          return payload
        }, [])

        const describeError = React.useCallback((error) => (
          error && error.status === 404
            ? t('serverMissing')
            : ((error && error.message) || String(error))
        ), [t])

        const reportFailure = React.useCallback((scope, error) => {
          setStatus('error')
          setErrorText(error && error.status === 404 ? t('serverMissing') : `${scope}：${(error && error.message) || error}`)
        }, [describeError, t])

        const applyDocumentResult = React.useCallback((payload) => {
          if (Array.isArray(payload?.documents)) setDocuments(payload.documents)
          if (payload?.activeDocumentId) setActiveDocumentId(payload.activeDocumentId)
          setCanvasReady(false)
          setDirty(false)
          setExternalStale(false)
          seenUpdatedAtRef.current = ''
          setReloadToken((token) => token + 1)
        }, [])

        const run = React.useCallback(async (task) => {
          setBusy(true)
          setErrorText('')
          try {
            await task()
          } catch (error) {
            setStatus('error')
            setErrorText(describeError(error))
          } finally {
            setBusy(false)
          }
        }, [describeError])

        const retryBoot = React.useCallback(() => {
          setStatus('loading')
          setErrorText('')
          setCanvasReady(false)
          return refreshDocuments({ reload: true })
            .then(() => setStatus('ready'))
            .catch((error) => reportFailure(t('document'), error))
        }, [refreshDocuments, reportFailure, t])

        // 首次装载：读取文档列表。
        React.useEffect(() => {
          let cancelled = false
          refreshDocuments({ reload: false })
            .then(() => { if (!cancelled) setStatus('ready') })
            .catch((error) => { if (!cancelled) reportFailure(t('document'), error) })
          return () => { cancelled = true }
        }, [refreshDocuments, reportFailure, t])

        // 画布 → 宿主的消息。
        React.useEffect(() => {
          const onMessage = (event) => {
            if (event.origin !== window.location.origin) return
            const payload = event.data
            if (!payload || payload.channel !== CHANNEL) return

            if (payload.type === 'ready') {
              setCanvasReady(true)
              setStatus('ready')
              setErrorText('')
              setExternalStale(false)
              seenUpdatedAtRef.current = ''
              if (typeof payload.offline === 'boolean') setOffline(payload.offline)
              if (typeof payload.documentId === 'string' && payload.documentId) setActiveDocumentId(payload.documentId)
              return
            }
            if (payload.type === 'saved') {
              setDirty(false)
              // 画布自己保存产生的 updatedAt 也要记成「已见过」，
              // 否则下面的轮询会把它误判成外部写入并提示重载。
              if (typeof payload.updatedAt === 'string' && payload.updatedAt) seenUpdatedAtRef.current = payload.updatedAt
              setSavedAt(payload.updatedAt || new Date().toISOString())
              setOffline(false)
              if (typeof payload.documentId === 'string' && payload.documentId) setActiveDocumentId(payload.documentId)
              return
            }
            if (payload.type === 'dirty') {
              setDirty(true)
              return
            }
            if (payload.type === 'error') {
              if (payload.scope === 'save') setDirty(true)
              if (payload.scope === 'boot') setOffline(true)
              setNotice(`${payload.scope}：${payload.message}`)
              return
            }
            if (payload.type === 'snapshot') {
              const pending = snapshotRef.current.pending.get(payload.requestId)
              if (pending) {
                snapshotRef.current.pending.delete(payload.requestId)
                pending.resolve(payload)
              }
              if (typeof payload.offline === 'boolean') setOffline(payload.offline)
            }
          }
          window.addEventListener('message', onMessage)
          return () => window.removeEventListener('message', onMessage)
        }, [])

        // 关闭窗口前让画布把未落盘的改动刷出去。
        React.useEffect(() => {
          const flush = () => { if (dirty) message({ type: 'flush' }) }
          window.addEventListener('beforeunload', flush)
          return () => {
            window.removeEventListener('beforeunload', flush)
            flush()
          }
        }, [dirty, message])

        const loadWorkspaces = React.useCallback(() => {
          try {
            const snapshot = service?.ctx?.workspaces?.list?.getSnapshot?.()
            const items = Array.isArray(snapshot?.items) ? snapshot.items : []
            const visible = items.filter((item) => typeof service?.workspaceVisible !== 'function'
              || service.workspaceVisible(item.workspaceId, entry?.id))
            setWorkspaceList(visible)
            setWorkspaceId((current) => (current && visible.some((item) => item.workspaceId === current)
              ? current
              : visible[0]?.workspaceId || ''))
          } catch {
            setWorkspaceList([])
          }
        }, [service, entry])

        let hasSession = false
        try {
          const sessionId = typeof service?.currentSession === 'function' ? service.currentSession() : null
          hasSession = !!sessionId && service?.state?.sessionBindings?.[sessionId] === entry?.id
        } catch {
          hasSession = false
        }

        // 无会话时也不自动创建：先给出本工作台自己的入口，由用户点选后才能建会话。
        React.useEffect(() => {
          if (assist && !hasSession) loadWorkspaces()
        }, [assist, hasSession, loadWorkspaces])

        const dismissHint = React.useCallback(() => {
          setHintVisible(false)
          try { window.localStorage?.setItem(FIRST_USE_HINT_KEY, 'seen') } catch { /* 存储不可用时只影响本次提示 */ }
        }, [])

        const openDocument = (id) => run(async () => {
          if (id === activeDocumentId) {
            setCanvasReady(false)
            setReloadToken((token) => token + 1)
            return
          }
          applyDocumentResult(await writeDocuments({ action: 'open', id }))
        })

        const confirmDialog = (value) => {
          const current = dialog
          setDialog(null)
          if (!current) return
          if (current.kind === 'create') {
            return run(async () => applyDocumentResult(await writeDocuments({ action: 'create', name: value })))
          }
          if (current.kind === 'rename') {
            return run(async () => {
              const payload = await writeDocuments({ action: 'rename', id: current.id, name: value })
              if (Array.isArray(payload?.documents)) setDocuments(payload.documents)
            })
          }
          if (current.kind === 'delete') {
            return run(async () => applyDocumentResult(await writeDocuments({ action: 'delete', id: current.id })))
          }
          return undefined
        }

        const duplicateDocument = () => {
          const id = activeDocumentId
          if (!id) return
          return run(async () => applyDocumentResult(await writeDocuments({ action: 'duplicate', id })))
        }

        const importDocument = (file) => run(async () => {
          const text = await file.text()
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            throw new Error(t('importInvalid'))
          }
          // 同时接受本工作台导出的封装（{ data }）与裸导图数据。
          const data = parsed && parsed.data && parsed.data.root ? parsed.data : parsed
          if (!data || typeof data !== 'object' || !data.root) throw new Error(t('importInvalid'))
          const name = file.name.replace(/\.(json|dshmm)$/i, '') || t('defaultName')
          applyDocumentResult(await writeDocuments({ action: 'import', name, data }))
        })

        const requestSnapshot = React.useCallback(() => new Promise((resolve, reject) => {
          const id = requestId()
          const store = snapshotRef.current
          const timer = setTimeout(() => {
            store.pending.delete(id)
            reject(new Error(t('exportFailed')))
          }, SNAPSHOT_TIMEOUT_MS)
          store.pending.set(id, {
            resolve: (payload) => { clearTimeout(timer); resolve(payload) },
            reject
          })
          message({ type: 'snapshot', requestId: id })
        }), [message, requestId, t])

        const exportDocument = () => run(async () => {
          const payload = await requestSnapshot()
          const name = documents.find((item) => item.id === activeDocumentId)?.name || 'mind-map'
          downloadJson(`${name}.dshmm.json`, {
            app: 'dsh-mind-workbench',
            version: 1,
            documentId: payload.documentId || activeDocumentId,
            exportedAt: new Date().toISOString(),
            data: payload.data
          })
        })

        const saveNow = () => run(async () => {
          // 先让画布把内存状态刷到服务端，再刷新文档列表。
          message({ type: 'flush' })
          await new Promise((resolve) => setTimeout(resolve, 250))
          await refreshDocuments()
          setSavedAt(new Date().toISOString())
        })

        const useWorkspace = () => {
          if (!workspaceId) return
          return run(async () => {
            if (typeof service?.newSession === 'function') await service.newSession(workspaceId)
          })
        }

        const startWorkspaceSession = () => run(async () => {
          if (typeof service?.newWorkspaceSession === 'function') await service.newWorkspaceSession()
        })

        const statusState = offline ? 'offline' : dirty ? 'saving' : canvasReady ? 'ready' : 'loading'
        const statusText = offline
          ? t('statusOffline')
          : dirty
            ? t('statusSaving')
            : canvasReady
              ? `${t('statusSaved')}${savedAt ? ` · ${formatClock(savedAt)}` : ''}`
              : t('statusLoading')

        const reloadCanvas = () => {
          setExternalStale(false)
          setCanvasReady(false)
          setReloadToken((token) => token + 1)
        }

        // 轮询文档列表，发现「当前导图被画布之外的写入更新」时给出提示。
        // 首次观测只建立基线；画布自己的保存会先把 updatedAt 记进 seenUpdatedAtRef，
        // 所以这里不会因为自己保存而误报。
        React.useEffect(() => {
          if (!canvasReady) return undefined
          const timer = setInterval(() => {
            readDocuments().then((payload) => {
              const list = Array.isArray(payload?.documents) ? payload.documents : []
              setDocuments(list)
              const id = payload?.activeDocumentId || activeDocumentId
              const nextUpdatedAt = list.find((item) => item.id === id)?.updatedAt || ''
              if (!seenUpdatedAtRef.current) {
                seenUpdatedAtRef.current = nextUpdatedAt
                return
              }
              if (payload?.activeDocumentId && payload.activeDocumentId !== activeDocumentId) {
                setExternalStale(true)
                return
              }
              if (nextUpdatedAt && nextUpdatedAt !== seenUpdatedAtRef.current) setExternalStale(true)
            }).catch(() => { /* 轮询失败不打扰用户，下一轮再试 */ })
          }, EXTERNAL_POLL_MS)
          return () => clearInterval(timer)
        }, [canvasReady, activeDocumentId])

        const activeDocument = documents.find((item) => item.id === activeDocumentId)

        return h('div', { className: 'dshMw', 'data-active': active === false ? 'false' : 'true' },
          h('header', { className: 'dshMwToolbar', 'aria-label': t('panelTitle') },
            h('div', { className: 'dshMwBrand' },
              h('span', { className: 'dshMwBrandMark', 'aria-hidden': 'true' }, 'M'),
              h('span', null, t('title'))
            ),
            h('div', { className: 'dshMwGroup' },
              h('label', { className: 'dshMwHidden', htmlFor: 'dshMwDocument' }, t('document')),
              h('select', {
                id: 'dshMwDocument',
                className: 'dshMwSelect',
                value: activeDocumentId,
                disabled: busy || !documents.length,
                onChange: (event) => openDocument(event.target.value)
              },
              documents.length
                ? documents.map((item) => h('option', { key: item.id, value: item.id }, item.name))
                : h('option', { value: '' }, t('noDocuments')))
            ),
            h('div', { className: 'dshMwGroup' },
              h('button', { type: 'button', className: 'dshMwBtn', disabled: busy, onClick: () => setDialog({ kind: 'create', initialValue: t('defaultName') }) }, t('newDocument')),
              h('button', { type: 'button', className: 'dshMwBtn', disabled: busy || !activeDocumentId, onClick: () => setDialog({ kind: 'rename', id: activeDocumentId, initialValue: activeDocument?.name || '' }) }, t('rename')),
              h('button', { type: 'button', className: 'dshMwBtn', disabled: busy || !activeDocumentId, onClick: duplicateDocument }, t('duplicate')),
              h('button', { type: 'button', className: 'dshMwBtn', disabled: busy || !activeDocumentId || activeDocumentId === 'default', onClick: () => setDialog({ kind: 'delete', id: activeDocumentId, initialValue: activeDocument?.name || '' }) }, t('remove'))
            ),
            h('div', { className: 'dshMwGroup' },
              h('button', { type: 'button', className: 'dshMwBtn', disabled: busy || !canvasReady, onClick: exportDocument }, t('exportDocument')),
              h('button', { type: 'button', className: 'dshMwBtn', disabled: busy || !canvasReady, onClick: () => importRef.current?.click() }, t('importDocument')),
              h('button', { type: 'button', className: 'dshMwBtn', disabled: busy || !canvasReady, onClick: saveNow }, t('saveNow')),
              h('button', { type: 'button', className: 'dshMwBtn', 'data-variant': 'ghost', disabled: busy, onClick: () => { setCanvasReady(false); setReloadToken((token) => token + 1) } }, t('reload'))
            ),
            h('div', { className: 'dshMwSpacer' }),
            h('div', { className: 'dshMwStatus', 'data-tone': statusState === 'offline' ? 'error' : undefined, role: 'status', 'aria-live': 'polite' },
              h('span', { className: 'dshMwDot', 'data-state': statusState, 'aria-hidden': 'true' }),
              h('span', null, statusText)
            ),
            h('button', {
              type: 'button',
              className: 'dshMwBtn',
              'data-variant': 'ghost',
              onClick: () => setModelOpen(true)
            }, t('modelConfig')),
            h('button', {
              type: 'button',
              className: 'dshMwBtn',
              'data-variant': assist ? 'primary' : undefined,
              'aria-pressed': assist ? 'true' : 'false',
              onClick: () => setAssist((open) => !open)
            }, assist ? t('aiAssistOn') : t('aiAssist'))
          ),
          offline ? h('div', { className: 'dshMwWarn', role: 'alert' }, t('statusOffline')) : null,
          errorText
            ? h('div', { className: 'dshMwWarn', role: 'alert' }, `${errorText} `,
              h('button', { type: 'button', className: 'dshMwBtn', onClick: retryBoot }, t('retry')))
            : null,
          notice
            ? h('div', { className: 'dshMwWarn', role: 'status' },
              `${notice} `,
              h('button', { type: 'button', className: 'dshMwBtn', onClick: () => setNotice('') }, t('cancel')))
            : null,
          // 外部写入（Agent 调 mindmap_write）只改磁盘，画布不会自己知道：提示用户重载。
          externalStale
            ? h('div', { className: 'dshMwWarn', role: 'status' },
              `${t('externalUpdate')} `,
              h('button', { type: 'button', className: 'dshMwBtn', onClick: reloadCanvas }, t('reload')),
              h('button', { type: 'button', className: 'dshMwBtn', 'data-variant': 'ghost', onClick: () => setExternalStale(false) }, t('cancel')))
            : null,
          h('div', { className: 'dshMwBody' },
            h('div', { className: 'dshMwCanvas' },
              h('div', { className: 'dshMwFrameWrap' },
                h('iframe', {
                  key: reloadToken,
                  ref: frameRef,
                  className: 'dshMwFrame',
                  title: t('title'),
                  src: APP_URL,
                  // 演示模式与「全屏查看/全屏编辑」都调用 requestFullscreen：iframe 必须
                  // 显式授予该权限（Permissions Policy，另有 allowFullScreen 兼容旧写法），
                  // 否则调用会被拒绝，表现为「点演示模式没有反应」。
                  allow: 'fullscreen',
                  allowFullScreen: true,
                  // 画布是应用自身的完整 UI，需要脚本、表单与弹层能力；
                  // 它与 DSH 渲染进程同源，因此只放行同源能力。
                  sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups',
                  onLoad: () => setCanvasReady(false)
                }),
                // 服务端路由不可用时画布必然载不出来：给出可操作的提示与重试，而不是一直「正在载入…」。
                !canvasReady && status === 'error'
                  ? h('div', { className: 'dshMwOverlay', role: 'alert' },
                    h('strong', null, t('bootError')),
                    h('span', null, errorText || t('serverMissing')),
                    h('button', { type: 'button', className: 'dshMwBtn', onClick: retryBoot }, t('retry')))
                  : !canvasReady && !offline
                    ? h('div', { className: 'dshMwOverlay', role: 'status' }, h('strong', null, t('title')), h('span', null, t('statusLoading')))
                    : null,
                offline
                  ? h('div', { className: 'dshMwOverlay', role: 'alert' },
                    h('strong', null, t('bootError')),
                    h('span', null, t('statusOffline')))
                  : null
              )
            ),
            // 会话区默认收起（规范 4.1）：收起时画布占满主内容区；
            // 节点始终保留在文档中，宿主传入的输入树不会被反复卸载重建。
            h('aside', {
              className: 'dshMwDock',
              'aria-label': t('session'),
              hidden: !assist
            },
            // 宿主传入的原生 conversation 节点固定在会话区里：收起会话区或切换模式
            // 都不会卸载重建宿主的输入树。没有会话时由宿主置为隐藏。
            conversation
              ? h('div', { className: 'dshMwDockFill', hidden: !hasSession }, conversation)
              : null,
            // 无会话时的工作台自有入口（规范 4.1：不显示宿主通用无会话引导）。
            !hasSession
              ? h('div', { className: 'dshMwSession' },
                h('h2', null, t('sessionSetupTitle')),
                h('p', null, t('sessionSetupBody')),
                h('div', { className: 'dshMwSessionRow' },
                  h('button', {
                    type: 'button',
                    className: 'dshMwBtn',
                    'data-variant': 'primary',
                    disabled: busy,
                    onClick: startWorkspaceSession
                  }, t('newWorkspaceSession')),
                  workspaceList.length
                    ? h('span', { className: 'dshMwSessionRow' },
                      h('label', { className: 'dshMwHidden', htmlFor: 'dshMwWorkspace' }, t('workspaceLabel')),
                      h('select', {
                        id: 'dshMwWorkspace',
                        className: 'dshMwSelect',
                        value: workspaceId,
                        disabled: busy,
                        onChange: (event) => setWorkspaceId(event.target.value)
                      }, workspaceList.map((item) => h('option', { key: item.workspaceId, value: item.workspaceId }, item.title || item.workspaceId))),
                      h('button', {
                        type: 'button',
                        className: 'dshMwBtn',
                        disabled: busy || !workspaceId,
                        onClick: useWorkspace
                      }, t('useWorkspace')))
                    : h('span', null, t('noWorkspace'))
                ))
              : null
            )
          ),
          // 本工作台自己的首次进入状态：一行可关闭的说明，不占用聊天区。
          hintVisible
            ? h('div', { className: 'dshMwHint', role: 'status' },
              h('span', null, t('firstUseHint')),
              h('button', { type: 'button', className: 'dshMwBtn', 'data-variant': 'ghost', onClick: dismissHint }, t('dismiss')))
            : null,
          modelOpen ? h(ModelConfigDialog, { t, onClose: () => setModelOpen(false) }) : null,
          h('input', {
            ref: importRef,
            className: 'dshMwHidden',
            type: 'file',
            accept: '.json,.dshmm,application/json',
            onChange: (event) => {
              const file = event.target.files && event.target.files[0]
              event.target.value = ''
              if (file) importDocument(file).catch(() => {})
            }
          }),
          dialog
            ? h(Dialog, {
              title: dialog.kind === 'create' ? t('createTitle') : dialog.kind === 'rename' ? t('renameTitle') : t('deleteTitle'),
              description: dialog.kind === 'delete' ? t('deleteBody') : null,
              label: dialog.kind === 'delete' ? null : t('createLabel'),
              initialValue: dialog.initialValue,
              confirmText: dialog.kind === 'create' ? t('createConfirm') : dialog.kind === 'rename' ? t('renameConfirm') : t('deleteConfirm'),
              cancelText: t('cancel'),
              tone: dialog.kind === 'delete' ? 'danger' : 'primary',
              busy,
              onConfirm: confirmDialog,
              onCancel: () => setDialog(null)
            })
            : null
        )
      }
    }

    // ---------------------------------------------------------------- 装配 ----

    function apply(ctx) {
      installStyles()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mind-workbench: dictionaries')
      const t = ctx.locale.bind(NS)
      const Panel = createPanel(t)
      ctx.effect(() => ctx.desktopWorkbenches.register({
        title: 'DSH 思维导图',
        titleEn: 'DSH Mind Workbench',
        panelTitle: 'DSH 思维导图',
        description: '在工作台里创建、编辑和导出思维导图；文档保存在 DSH 数据目录，可与会话并行使用。',
        repository: REPOSITORY,
        // 与工作台市场分类的 id 对齐（development / productivity / content / data / research / operations / other）
        category: '效率',
        // 思维导图需要尽可能大的画布：使用 customFrame 占据主内容区，
        // 并自行把宿主提供的原生会话节点停靠在右侧（不新建聊天界面）。
        customFrame: true
      }, Panel), 'dsh-mind-workbench: registration')
    }

    return { apply, inject: ['desktopWorkbenches', 'locale'] }
  }
})
