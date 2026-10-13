/**
 * DSH 思维导图工作台 · 服务端入口。
 *
 * 职责只有两件事：
 *   1. 把 `app/` 下已经构建好的画布静态应用托管在本工作台自己的
 *      `/api/dsh-mind-workbench/app/` 路径前缀下。宿主渲染进程与 Harness
 *      WebServer 同源，因此工作台面板里的 iframe 属于同源文档，可以直接调用
 *      下面的文档接口，不需要额外的跨源协商。
 *   2. 提供确定性的文档存取接口，让思维导图数据落在 DSH 数据目录
 *      （`cordis.patch.yml` 里的 `dshHomePath('mind-workbench')`）中，
 *      而不是浏览器的 localStorage 里。
 *
 * 静态路由在插件装载时按文件逐个注册：工作台的 fetch 路由按精确路径匹配，
 * 没有目录级通配，因此这里在装载期枚举 `app/` 并一一登记。
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-mind-workbench'
// 模块级声明依赖，apply 里直接使用 —— 与 @deepseek-ai/dsh-image-generation 完全相同
// 的写法。tools / systemPrompt 是 Harness 的核心服务：只有这样才能让注册出来的工具
// 真正进入会话的能力清单（用 ctx.inject(['tools'], …) 注册到子作用域是不够的）。
export const inject = ['connection', 'tools', 'systemPrompt']
export const Config = Schema.object({
  root: Schema.string().required()
})

const API = '/api/dsh-mind-workbench'
const APP_URL = `${API}/app`
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app')
// mindmap_read 的返回会整段进入对话上下文，必须设上限（见工具实现）。
const MAX_OUTLINE_LINES = 400

const STATE_FILE = 'state.json'
const DOCUMENTS_DIR = 'documents'
const DEFAULT_DOCUMENT_ID = 'default'
const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_NAME_LENGTH = 120

const MIME_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
}))

class WorkbenchError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export function contentTypeFor(file) {
  return MIME_TYPES.get(extname(file).toLowerCase()) || 'application/octet-stream'
}

function cacheControlFor(file) {
  const extension = extname(file).toLowerCase()
  // 入口页必须每次校验，其余构建产物带 query hash，但仍保持可校验以支持本地重建。
  if (extension === '.html' || extension === '.htm') return 'no-store'
  return 'no-cache'
}

/**
 * Harness 的精确 fetch 路由要求 `/api/` 之后的**每一段路径**都匹配
 * `ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/`（依据已安装应用内的 connection 实现）。
 *
 * 百分号编码、空格、非 ASCII 一律会被判为 `invalid exact Fetch route`。
 * 更严重的是：这个校验失败如果发生在**异步链**里，会升级成 unhandled rejection，
 * 进而 `dsh: fatal load failure` 打死整个 Harness（不是只让本插件失效）。
 * 因此登记前必须同步筛一遍：只登记合规路径，其余记录后跳过，绝不抛错。
 */
const ROUTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

function isRegistrableAppPath(relative) {
  if (!relative || relative.startsWith('/') || relative.includes('\\')) return false
  return relative
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..' && ROUTE_SEGMENT_PATTERN.test(segment))
}

function collectFilesSync(directory, prefix = '') {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const collected = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) collected.push(...collectFilesSync(join(directory, entry.name), relative))
    else if (entry.isFile()) collected.push(relative)
  }
  return collected
}

async function collectFiles(directory, prefix = '') {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const collected = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) collected.push(...(await collectFiles(join(directory, entry.name), relative)))
    else if (entry.isFile()) collected.push(relative)
  }
  return collected
}

function staticRoute(relative) {
  const file = join(APP_ROOT, relative)
  // 路径必须原样使用：调用方已保证每段都合规（ASCII），不需要也不能做百分号编码。
  const path = `${APP_URL}/${relative}`
  return {
    path,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    async fetch(request) {
      let payload
      try {
        payload = await readFile(file)
      } catch {
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })
      }
      const headers = {
        'content-type': contentTypeFor(relative),
        'cache-control': cacheControlFor(relative),
        'content-length': String(payload.byteLength)
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(payload, { status: 200, headers })
    }
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

function documentFile(root, id) {
  return join(root, DOCUMENTS_DIR, `${id}.json`)
}

async function readBody(request) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new WorkbenchError('请求内容过大。', 413)
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new WorkbenchError('请求内容过大。', 413)
  if (!text) throw new WorkbenchError('请求需要 JSON 正文。')
  try {
    return JSON.parse(text)
  } catch {
    throw new WorkbenchError('请求正文不是合法 JSON。')
  }
}

function normalizeName(value, fallback) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) return fallback
  if (name.length > MAX_NAME_LENGTH) throw new WorkbenchError(`名称不能超过 ${MAX_NAME_LENGTH} 个字符。`)
  return name
}

function normalizeDocumentId(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_DOCUMENT_ID
  if (typeof value !== 'string' || !DOCUMENT_ID_PATTERN.test(value)) throw new WorkbenchError('文档标识不合法。')
  return value
}

function normalizeData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkbenchError('思维导图数据必须是对象。')
  if (!value.root || typeof value.root !== 'object') throw new WorkbenchError('思维导图数据缺少根节点。')
  return value
}

function normalizeState(stored) {
  return {
    version: 1,
    activeDocumentId: normalizeDocumentId(stored?.activeDocumentId),
    language: typeof stored?.language === 'string' && stored.language ? stored.language : 'zh',
    mindMapConfig: stored?.mindMapConfig && typeof stored.mindMapConfig === 'object' ? stored.mindMapConfig : {},
    localConfig: stored?.localConfig && typeof stored.localConfig === 'object' ? stored.localConfig : null,
    updatedAt: typeof stored?.updatedAt === 'string' ? stored.updatedAt : null
  }
}

function readState(root) {
  return readJson(join(root, STATE_FILE)).then(normalizeState)
}

async function writeState(root, state) {
  const next = { ...normalizeState(state), updatedAt: new Date().toISOString() }
  await writeJsonAtomic(join(root, STATE_FILE), next)
  return next
}

function readDocument(root, id) {
  return readJson(documentFile(root, id))
}

async function writeDocument(root, document) {
  const next = { ...document, version: 1, updatedAt: new Date().toISOString() }
  await writeJsonAtomic(documentFile(root, document.id), next)
  return next
}

async function listDocuments(root) {
  const directory = join(root, DOCUMENTS_DIR)
  const files = await collectFiles(directory)
  const documents = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -'.json'.length)
    if (!DOCUMENT_ID_PATTERN.test(id)) continue
    const stored = await readJson(join(directory, file))
    if (!stored || !stored.data) continue
    let size = 0
    try {
      size = (await stat(join(directory, file))).size
    } catch {
      size = 0
    }
    documents.push({
      id,
      name: typeof stored.name === 'string' && stored.name ? stored.name : id,
      createdAt: stored.createdAt || null,
      updatedAt: stored.updatedAt || null,
      size
    })
  }
  documents.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
  return documents
}

function exampleDocument(id, name) {
  return {
    id,
    name,
    createdAt: new Date().toISOString(),
    data: {
      root: { data: { text: 'DSH 思维导图' }, children: [] },
      theme: { template: 'avocado', config: {} },
      layout: 'logicalStructure',
      config: {},
      view: null
    }
  }
}

function newDocumentId() {
  return `map-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 保证「默认文档」永远存在，并返回它与归一化后的状态。
 * 默认文档被删除或首次启动时都会在这里补齐；它不可被删除。
 */
async function ensureDefaultDocument(root) {
  const state = await readState(root)
  let document = await readDocument(root, state.activeDocumentId)
  if (!document) {
    if (state.activeDocumentId !== DEFAULT_DOCUMENT_ID) {
      state.activeDocumentId = DEFAULT_DOCUMENT_ID
      await writeState(root, state)
    }
    document = (await readDocument(root, DEFAULT_DOCUMENT_ID))
      || (await writeDocument(root, exampleDocument(DEFAULT_DOCUMENT_ID, '未命名导图')))
  }
  return { document, state }
}

function failure(error, fallback) {
  const message = error instanceof WorkbenchError ? error.message : fallback
  const status = error instanceof WorkbenchError ? error.status : 500
  return Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } })
}

function json(value) {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function route(path, methods, fetch) {
  return { path: `${API}/${path}`, methods, requestBody: 'buffered', fetch }
}

// ============================================================ AI 供应商配置 ==
//
// 画布源码画布的 AI 请求并不是直连模型厂商：它把
//   { api, method, headers: { Authorization }, data: { model, stream, messages } }
// POST 到「本地桥」（默认 http://localhost:3456/ai/chat，闭源客户端提供）。
// 也就是说这个桥**就是个通用转发器**。于是本工作台自己实现这个桥
// （scripts/sync-app.mjs 会把画布里的地址改成本包的同源路径），
// 并在转发前按用户选择的供应商覆盖 api / 鉴权 / 模型名。
// 各家主流厂商都提供 OpenAI 兼容的 /chat/completions，所以不需要逐家写适配。

export const AI_PROVIDERS = [
  { id: 'volcano', name: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'ep-xxxxxxxx', note: '模型填「推理接入点 ID」（ep-…）' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'moonshot', name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'dashscope', name: '阿里云通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { id: 'ollama', name: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', noKey: true },
  { id: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: '', model: '' }
]

function normalizeAiProvider(stored) {
  const providerId = AI_PROVIDERS.some((item) => item.id === stored?.providerId) ? stored.providerId : ''
  return {
    providerId,
    baseUrl: typeof stored?.baseUrl === 'string' ? stored.baseUrl.trim() : '',
    apiKey: typeof stored?.apiKey === 'string' ? stored.apiKey : '',
    model: typeof stored?.model === 'string' ? stored.model.trim() : ''
  }
}

async function readAiProvider(root) {
  const state = await readJson(join(root, STATE_FILE))
  return normalizeAiProvider(state?.aiProvider)
}

async function writeAiProvider(root, provider) {
  const raw = (await readJson(join(root, STATE_FILE))) || {}
  const next = { ...normalizeState(raw), aiProvider: normalizeAiProvider(provider) }
  await writeJsonAtomic(join(root, STATE_FILE), { ...next, updatedAt: new Date().toISOString() })
  return next.aiProvider
}

/** 把供应商 baseUrl 拼成 chat/completions 端点；已经是完整端点时原样返回。 */
export function aiEndpointFor(baseUrl, fallbackApi) {
  const base = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : ''
  if (!base) return typeof fallbackApi === 'string' ? fallbackApi : ''
  if (/\/chat\/completions$/i.test(base)) return base
  return `${base}/chat/completions`
}

function assertForwardableUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new WorkbenchError('模型接口地址无效。')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new WorkbenchError('模型接口只支持 http/https。')
  return parsed.toString()
}

// ============================================================== 大纲 ⇄ 导图 ==
//
// Agent 用自然语言最容易写的就是 Markdown 大纲，所以工具层做一层转换：
// 标题层级 + 缩进列表 → 画布使用的 { root: { data, children } }。

export function outlineToMindMap(outline, fallbackTitle = '思维导图') {
  const text = typeof outline === 'string' ? outline : ''
  const root = { data: { text: fallbackTitle }, children: [] }
  const stack = [{ level: -1, node: root }]
  let rootNamed = false

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) continue
    if (/^\s*```/.test(raw)) continue

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw.trim())
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw)
    let level
    let label

    if (heading) {
      level = heading[1].length - 1
      label = heading[2].trim()
      if (level === 0 && !rootNamed && root.children.length === 0) {
        root.data.text = label || root.data.text
        rootNamed = true
        continue
      }
      if (level === 0) level = 1
    } else if (bullet) {
      level = Math.floor(bullet[1].replace(/\t/g, '  ').length / 2) + 1
      label = bullet[2].trim()
    } else {
      level = 1
      label = raw.trim()
    }

    if (!label) continue
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()
    const parent = stack[stack.length - 1].node
    const node = { data: { text: label }, children: [] }
    parent.children.push(node)
    stack.push({ level, node })
  }
  return root
}

export function mindMapToOutline(root, depth = 0) {
  const lines = []
  const walk = (node, level) => {
    if (!node || !node.data) return
    const text = String(node.data.text ?? '').trim()
    if (text) {
      if (level === 0) lines.push(`# ${text}`)
      else if (level === 1) lines.push(`## ${text}`)
      else lines.push(`${'  '.repeat(level - 2)}- ${text}`)
    }
    for (const child of node.children || []) walk(child, level + 1)
  }
  walk(root, depth)
  return lines.join('\n')
}

export function apply(ctx, config) {
  const root = resolve(config.root)
  const hosted = { files: 0, skipped: [], rejected: [] }

  // 静态应用：**同步**枚举 `app/` 并逐文件登记精确路由。
  //
  // 三个必须遵守的约束（每一条都踩过）：
  //   1. 一个路径只能登记一次（Harness 的 fetch 路由表按 pathname 唯一，重复登记抛错）；
  //   2. 路径每一段必须匹配 `[A-Za-z0-9_$.-]`，否则判为 invalid exact Fetch route；
  //   3. 任何抛错都必须在插件自己的 effect 内发生 —— 抛在异步链里会变成
  //      unhandled rejection，最终 `dsh: fatal load failure` 打死整个 Harness。
  // 因此这里同步枚举、登记前校验、不合规/重复的路径只记录并跳过，绝不抛错。
  ctx.effect(() => {
    const disposers = []
    const registered = new Set()
    const register = (entry) => {
      if (registered.has(entry.path)) return false
      // 兜底：白名单已按段过滤，但路由表校验由宿主实现，规则可能比文档更严。
      // 曾经 1.0.1 就是因为这里抛出非法路由而在异步链里升级为 fatal load failure，
      // 直接把整台 Harness 打死——所以任何登记失败都只记录、不上抛。
      try {
        const dispose = ctx.connection.fetch.register(entry)
        registered.add(entry.path)
        if (typeof dispose === 'function') disposers.push(dispose)
        return true
      } catch (error) {
        const reason = (error && error.message) || String(error)
        hosted.rejected.push(`${entry.path}（${reason}）`)
        return false
      }
    }

    for (const file of collectFilesSync(APP_ROOT)) {
      if (!isRegistrableAppPath(file)) {
        hosted.skipped.push(file)
        continue
      }
      if (register(staticRoute(file))) hosted.files += 1
    }
    if (hosted.skipped.length) {
      // 跳到 stdout 便于在 harness.log 里定位；同时通过 /health 暴露给自检。
      console.warn(`[dsh-mind-workbench] 跳过 ${hosted.skipped.length} 个非法静态路径（需为 [A-Za-z0-9_$.-]）：${hosted.skipped.slice(0, 5).join('、')}`)
    }
    if (hosted.rejected.length) {
      console.warn(`[dsh-mind-workbench] 被宿主拒绝的静态路由 ${hosted.rejected.length} 条（已跳过，不影响其他路由）：${hosted.rejected.slice(0, 5).join('、')}`)
    }

    return () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose()
      }
    }
  }, 'mind-workbench: static app routes')

  // 业务接口：同样登记在 effect 内，插件重载/卸载时才会撤销旧路由。
  ctx.effect(() => {
    const disposers = []
    const register = (entry) => {
      // 业务接口的路径都是本插件写死的 ASCII，但仍不上抛：装载期任何抛错都可能
      // 变成 fatal load failure，代价是整台 Harness 起不来。
      try {
        const dispose = ctx.connection.fetch.register(entry)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        console.warn(`[dsh-mind-workbench] 接口路由 ${entry.path} 登记失败：${(error && error.message) || error}`)
      }
    }

    register(route('health', ['GET'], async () => {
      let documents = 0
      try {
        documents = (await listDocuments(root)).length
      } catch {
        documents = 0
      }
      return json({
        ok: true,
        name,
        app: `${APP_URL}/index.html`,
        root,
        files: hosted.files,
        skipped: hosted.skipped,
        documents
      })
    }))

    // 应用启动时读取当前文档与偏好设置（接管模式的数据源）。
    register(route('session', ['GET'], async () => {
      try {
        const { document, state } = await ensureDefaultDocument(root)
        return json({
          documentId: document.id,
          document: { id: document.id, name: document.name, data: document.data },
          language: state.language,
          mindMapConfig: state.mindMapConfig,
          localConfig: state.localConfig,
          updatedAt: document.updatedAt || null
        })
      } catch (error) {
        return failure(error, '无法读取思维导图数据。')
      }
    }))

    // 应用在画布变更后回写当前文档数据。
    register(route('session/data', ['POST'], async (request) => {
      try {
        const payload = await readBody(request)
        const id = normalizeDocumentId(payload.documentId)
        const data = normalizeData(payload.data)
        const existing = await readDocument(root, id)
        // 只有 documents 接口与 mindmap_write 能创建文档；这条路由只保存**已存在**的文档。
        // 早期版本在这里兜底创建（`|| exampleDocument(id, id)`），代价有两个：
        //   1. 删除文档的瞬间画布仍在自动保存（400ms 防抖 + 卸载时 sendBeacon），
        //      被删掉的文档会带着空数据复活，并且名字变成它的 id（就是列表里
        //      `map-xxxx-yyyy` 那种条目的来源）；
        //   2. 用 activeDocumentId 当放行条件也拦不住——删除动作里「删文件」与
        //      「移开当前指针」之间有个窗口，恰好落在这个窗口里的保存会把文档写回来。
        // 现在无条件要求文档已存在，这条竞态从根上没有了。
        if (!existing) throw new WorkbenchError('文档不存在。', 404)
        const document = await writeDocument(root, { ...existing, id, data })
        // 这里**不能**顺手把 activeDocumentId 改成 id：切换文档时，旧画布会在卸载阶段
        // 用 sendBeacon 把旧文档补写一次，若在此处抢 active，刚切过去的新文档会被立刻
        // 抢回旧文档（表现为「新建的导图打不开，永远打开第一个」）。
        // 谁是当前文档只由 documents 接口的显式动作（open/create/import/duplicate）决定。
        return json({ ok: true, documentId: id, updatedAt: document.updatedAt })
      } catch (error) {
        return failure(error, '无法保存思维导图数据。')
      }
    }))

    // ---------------------------------------------------------- AI 供应商配置 --
    register(route('ai/providers', ['GET'], async () => json({ providers: AI_PROVIDERS })))

    register(route('ai/settings', ['GET', 'POST'], async (request) => {
      if (request?.method !== 'POST') {
        try {
          return json(await readAiProvider(root))
        } catch (error) {
          return failure(error, '无法读取模型配置。')
        }
      }
      try {
        const payload = await readBody(request)
        return json({ ok: true, ...(await writeAiProvider(root, payload)) })
      } catch (error) {
        return failure(error, '无法保存模型配置。')
      }
    }))

    // 画布的「连接检测」打这里。画布源码用它判断闭源客户端的本地服务是否活着；
    // 本工作台自己就是这个桥，所以只要路由在就回 200，避免误报「请下载客户端」。
    // 真正缺配置时会在 /ai/chat 上给出可读的错误。
    register(route('ai/test', ['GET'], async () => {
      try {
        const provider = await readAiProvider(root)
        return json({ ok: true, bridge: 'dsh-mind-workbench', configured: Boolean(provider.baseUrl || provider.apiKey) })
      } catch {
        return json({ ok: true, bridge: 'dsh-mind-workbench', configured: false })
      }
    }))

    // 本地 AI 桥：画布的 AI 请求都打到这里，再按配置转发到所选供应商。
    // 画布源码把 { api, method, headers, data } 原样交给本地桥，所以这里只需覆盖
    // 端点 / 鉴权 / 模型名，然后把它当作 SSE 透传回去。
    register(route('ai/chat', ['POST'], async (request) => {
      try {
        const payload = await readBody(request)
        const provider = await readAiProvider(root)
        const supplied = payload?.headers && typeof payload.headers === 'object' ? payload.headers : {}
        // 画布「AI 配置」弹窗把 Key 放进 Authorization 头。填了 Key 就说明用户是照它配的，
        // 那就以画布为准（最具体）；没填才回退到面板「模型配置」的统一配置。
        const rawAuth = typeof supplied.Authorization === 'string'
          ? supplied.Authorization
          : (typeof supplied.authorization === 'string' ? supplied.authorization : '')
        const canvasKey = rawAuth.replace(/^Bearer\s+/i, '').trim()
        const fromCanvas = Boolean(canvasKey)

        const endpoint = aiEndpointFor(fromCanvas ? payload?.api : provider.baseUrl, '')
        if (!endpoint) {
          throw new WorkbenchError('尚未配置模型：请在画布「AI 配置」里填写 API Key 与模型 URL，或在工作台面板的「模型配置」里选择供应商。')
        }
        const targetUrl = assertForwardableUrl(endpoint)

        const headers = { 'content-type': 'application/json' }
        for (const [key, value] of Object.entries(supplied)) {
          const lower = key.toLowerCase()
          if (typeof value !== 'string' || lower === 'host' || lower === 'content-length') continue
          // 画布总会带上 `Bearer ` + key，Key 为空时不要把这个空凭据透传上去。
          if (lower === 'authorization' && !value.replace(/^Bearer\s+/i, '').trim()) continue
          headers[lower] = value
        }
        if (!fromCanvas && provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`

        const data = { ...(payload?.data && typeof payload.data === 'object' ? payload.data : {}) }
        if (provider.model && (!fromCanvas || !data.model)) data.model = provider.model
        data.stream = true

        const upstream = await fetch(targetUrl, {
          method: typeof payload?.method === 'string' && payload.method ? payload.method : 'POST',
          headers,
          body: JSON.stringify(data),
          signal: request.signal
        })
        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => '')
          return Response.json(
            { error: `模型接口返回 HTTP ${upstream.status}`, detail: detail.slice(0, 2000) },
            { status: upstream.status, headers: { 'cache-control': 'no-store' } }
          )
        }
        return new Response(upstream.body, {
          status: 200,
          headers: {
            'content-type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store'
          }
        })
      } catch (error) {
        return failure(error, '模型请求失败。')
      }
    }))

    // 语言、实例化配置、本地配置等偏好设置。
    register(route('session/preferences', ['POST'], async (request) => {
      try {
        const payload = await readBody(request)
        const state = await readState(root)
        if (payload.language !== undefined) {
          if (typeof payload.language !== 'string' || !payload.language) throw new WorkbenchError('语言设置不合法。')
          state.language = payload.language
        }
        if (payload.mindMapConfig !== undefined) {
          if (!payload.mindMapConfig || typeof payload.mindMapConfig !== 'object') throw new WorkbenchError('实例化配置必须是对象。')
          state.mindMapConfig = payload.mindMapConfig
        }
        if (payload.localConfig !== undefined) {
          state.localConfig = payload.localConfig && typeof payload.localConfig === 'object' ? payload.localConfig : null
        }
        const next = await writeState(root, state)
        return json({ ok: true, updatedAt: next.updatedAt })
      } catch (error) {
        return failure(error, '无法保存偏好设置。')
      }
    }))

    // 文档接口：GET 读取列表，POST 执行 create / open / rename / duplicate / import / delete。
    // connection 的 fetch 路由按「精确路径」登记，同路径只能登记一次（不按方法区分），
    // 因此 GET 与 POST 必须合并为一条多方法路由，再按 request.method 分派。
    // 拆成两条 register 时，第二条会抛
    // `connection: exact Fetch route "/api/dsh-mind-workbench/documents" is already registered`。
    register(route('documents', ['GET', 'POST'], async (request) => {
      if (request?.method !== 'POST') {
        try {
          const { state } = await ensureDefaultDocument(root)
          return json({ documents: await listDocuments(root), activeDocumentId: state.activeDocumentId })
        } catch (error) {
          return failure(error, '无法读取文档列表。')
        }
      }

      try {
        const payload = await readBody(request)
        const action = payload.action
        const state = await readState(root)
        let activeDocumentId = state.activeDocumentId
        let document = null

        if (action === 'create') {
          const id = newDocumentId()
          document = await writeDocument(root, exampleDocument(id, normalizeName(payload.name, '未命名导图')))
          activeDocumentId = id
        } else if (action === 'import') {
          const id = newDocumentId()
          document = await writeDocument(root, {
            id,
            name: normalizeName(payload.name, '导入的导图'),
            createdAt: new Date().toISOString(),
            data: normalizeData(payload.data)
          })
          activeDocumentId = id
        } else if (action === 'open') {
          const id = normalizeDocumentId(payload.id)
          document = await readDocument(root, id)
          if (!document) throw new WorkbenchError('文档不存在。', 404)
          activeDocumentId = id
        } else if (action === 'rename') {
          const id = normalizeDocumentId(payload.id)
          const existing = await readDocument(root, id)
          if (!existing) throw new WorkbenchError('文档不存在。', 404)
          document = await writeDocument(root, { ...existing, name: normalizeName(payload.name, existing.name) })
        } else if (action === 'duplicate') {
          const source = await readDocument(root, normalizeDocumentId(payload.id))
          if (!source) throw new WorkbenchError('文档不存在。', 404)
          const id = newDocumentId()
          document = await writeDocument(root, {
            id,
            name: normalizeName(payload.name, `${source.name} 副本`),
            createdAt: new Date().toISOString(),
            data: source.data
          })
          activeDocumentId = id
        } else if (action === 'delete') {
          const id = normalizeDocumentId(payload.id)
          if (id === DEFAULT_DOCUMENT_ID) throw new WorkbenchError('默认文档不可删除。')
          const existing = await readDocument(root, id)
          if (!existing) throw new WorkbenchError('文档不存在。', 404)
          // 先把「当前文档」移开，再删文件：反过来会给正在自动保存的画布留一个窗口，
          // 落在窗口里的保存请求会把刚删掉的文档写回来（删除后自动恢复的直接原因）。
          if (activeDocumentId === id) {
            activeDocumentId = DEFAULT_DOCUMENT_ID
            state.activeDocumentId = DEFAULT_DOCUMENT_ID
            await writeState(root, state)
          }
          await unlink(documentFile(root, id))
          document = (await ensureDefaultDocument(root)).document
        } else {
          throw new WorkbenchError('不支持的文档操作。')
        }

        if (state.activeDocumentId !== activeDocumentId) {
          state.activeDocumentId = activeDocumentId
          await writeState(root, state)
        }
        return json({
          ok: true,
          action,
          activeDocumentId,
          document: document ? { id: document.id, name: document.name, data: document.data } : null,
          documents: await listDocuments(root)
        })
      } catch (error) {
        return failure(error, '文档操作失败。')
      }
    }))

    return () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose()
      }
    }
  }, 'mind-workbench: api routes')

  // -------------------------------------------------------- Agent 可调用工具 --
  //
  // 桌面会话里的 Agent 要能"用对话框把导图画出来"，就必须有可调用的接口——
  // 只注册客户端面板是不够的（面板是本插件自己的 UI，不在 Agent 的能力清单里）。
  // 这里把导图读写注册成 DSH 工具。
  //
  // 写法与 @deepseek-ai/dsh-image-generation 一致：模块级 inject 声明 tools /
  // systemPrompt，然后在 apply 里直接 ctx.tools.register(...)。
  // 早期版本写成 ctx.inject(['tools'], scope => scope.tools.register(...))：工具确实进了
  // 注册表（日志也打印了），但注册在子作用域里，**没进会话的能力清单**，所以对话框里调不到。
  registerMindMapTools(ctx, defineTool, root)
  console.log('[dsh-mind-workbench] 已注册 Agent 工具：mindmap_list / mindmap_read / mindmap_write')

  // 工具光存在还不够，模型得知道有这个能力、什么时机用。这一段进入系统提示，
  // 与 image-generation 的 `tool:image-generation` 同一机制。
  ctx.systemPrompt.section({
    name: 'tool:mind-map-workbench',
    order: 130,
    text: [
      'DSH mind-map workbench: you can read and edit the user\'s mind maps.',
      'mindmap_list lists the documents (and marks the one open on the canvas); mindmap_read returns one document as a Markdown outline;',
      'mindmap_write creates or overwrites a document from a Markdown outline.',
      'When the user asks to draw, outline, reorganise or summarise something as a mind map (思维导图 / 脑图 / mind map / outline / 脑图梳理),',
      'call mindmap_write with a Markdown outline ("# " root, "## " first-level branches, two-space-indented "- " for deeper levels)',
      'instead of only describing the structure in prose. Prefer mindmap_read for the document currently open in the workbench, and mindmap_list when the target is unclear.',
      'The canvas notices external writes within a few seconds and offers 「重新载入」; tell the user to click it if the canvas looks stale.',
      'The canvas also has its own AI provider configuration (the AI 配置 dialog): that is for the canvas-side AI features and uses the provider the user configured there or in the workbench toolbar, not your model.'
    ].join(' ')
  })
}

function countNodes(node) {
  if (!node) return 0
  return 1 + (node.children || []).reduce((total, child) => total + countNodes(child), 0)
}

/** 把 `output` 声明成"一段文本"，避免对象 schema 的编译面。 */
function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  }
}

/**
 * 注册三个导图工具。参数只使用字符串，输出是 Markdown/文本，
 * 这样既不触碰复杂 schema 方言，也恰好是模型最容易写对的形式。
 */
export function registerMindMapTools(scope, defineTool, root) {
  const register = (tool) => scope.tools.register(tool)

  register(defineTool({
    name: 'mindmap_list',
    description: 'List the mind-map documents of the DSH mind-map workbench (id, name, last updated), and show which one is currently open on the canvas.',
    parameters: {},
    output: textOutput(),
    async execute() {
      const { state } = await ensureDefaultDocument(root)
      const documents = await listDocuments(root)
      const lines = documents.map((doc) => `- ${doc.name}（id=${doc.id}，更新于 ${doc.updatedAt || '未知'}）${doc.id === state.activeDocumentId ? ' ← 画布当前打开' : ''}`)
      return `共 ${documents.length} 个导图文档：\n${lines.join('\n')}`
    }
  }))

  register(defineTool({
    name: 'mindmap_read',
    description: 'Read one mind-map document as a Markdown outline. Omit documentId to read the document currently open on the canvas.',
    parameters: {
      documentId: { type: 'string', description: 'Document id from mindmap_list. Omit to read the open document.' }
    },
    output: textOutput(),
    async execute(args) {
      const id = args?.documentId ? normalizeDocumentId(String(args.documentId)) : (await readState(root)).activeDocumentId
      const document = await readDocument(root, id)
      if (!document) throw new WorkbenchError(`文档不存在：${id}`, 404)
      const outline = mindMapToOutline(document.data?.root)
      // 工具结果会整段进入对话上下文：大导图必须截断，否则一次读取就能把上下文挤爆。
      const allLines = outline ? outline.split('\n') : []
      const capped = allLines.length > MAX_OUTLINE_LINES
        ? `${allLines.slice(0, MAX_OUTLINE_LINES).join('\n')}\n…（另有 ${allLines.length - MAX_OUTLINE_LINES} 行未显示：导图过大，建议先只处理需要的分支）`
        : outline
      return `文档：${document.name}（id=${document.id}，共 ${countNodes(document.data?.root)} 个节点）\n\n${capped || '（空导图）'}`
    }
  }))

  register(defineTool({
    name: 'mindmap_write',
    description: 'Create or overwrite a mind map in the DSH mind-map workbench from a Markdown outline. This tool replaces a document as a whole, so call mindmap_read before changing an existing map, and pass documentId only when you really mean to overwrite that document. Use "# 主题" for the root topic, "## " for first-level branches, and "- " with two-space indentation for deeper levels. The canvas reloads to show the result.',
    parameters: {
      outline: { type: 'string', required: true, description: 'Markdown outline of the mind map.' },
      name: { type: 'string', description: 'Document name; defaults to the root topic of the outline.' },
      documentId: { type: 'string', description: 'Overwrite this existing document id instead of creating a new one.' }
    },
    output: textOutput(),
    async execute(args) {
      const outline = String(args?.outline ?? '')
      if (!outline.trim()) throw new WorkbenchError('outline 不能为空。')
      const rootNode = outlineToMindMap(outline, normalizeName(args?.name, '思维导图'))
      const requestedName = normalizeName(args?.name, '')
      const name = requestedName || normalizeName(rootNode.data.text, '思维导图')
      const existing = args?.documentId ? await readDocument(root, normalizeDocumentId(String(args.documentId))) : null
      const id = existing?.id || newDocumentId()
      const data = {
        root: rootNode,
        theme: existing?.data?.theme || { template: 'avocado', config: {} },
        layout: existing?.data?.layout || 'logicalStructure',
        config: existing?.data?.config || {},
        view: null
      }
      const document = await writeDocument(root, {
        ...(existing || { id, name, createdAt: new Date().toISOString() }),
        id,
        name,
        data
      })
      const state = await readState(root)
      if (state.activeDocumentId !== id) {
        state.activeDocumentId = id
        await writeState(root, state)
      }
      return `已${existing ? '整体覆盖' : '新建'}导图「${document.name}」（id=${document.id}），共 ${countNodes(rootNode)} 个节点。`
        + (existing ? '（原内容已被替换，不保留历史）' : '')
        + `\n画布会自动刷新；若未刷新，请点工具栏的「重新载入」。`
    }
  }))
}
