#!/usr/bin/env node
/**
 * DSHMindWorkbench 冒烟测试。
 *
 * 与 `verify.mjs` 的区别：verify 做的是确定性单元/接口自检（内存宿主直接调路由），
 * 本脚本把插件真实地跑成一台 HTTP 服务，用真实网络请求打一遍完整链路，
 * 供人工或 agent-browser 做界面级冒烟：
 *
 *   1. HTTP 冒烟（自动，总是执行）
 *      - 静态资源：入口页、构建产物、字体、ICO、非 ASCII 文件名、404
 *      - 画布启动链路：GET /session
 *      - 自动保存链路：POST /session/data → 落盘 → 再 GET /session 读回
 *      - 文档管理：create/open/rename/duplicate/import/delete
 *      - 偏好设置：language / mindMapConfig
 *   2. 界面冒烟（--serve 时由浏览器驱动）
 *      启动常驻服务并打印 `SMOKE_READY <url>`，配合 agent-browser 打开入口页，
 *      验证画布挂载、接管模式生效，再回到本脚本用 `--check-disk <关键字>` 断言
 *      浏览器里的编辑已经落盘。
 *
 * 用法：
 *   node scripts/smoke.mjs                       # 只跑 HTTP 冒烟
 *   node scripts/smoke.mjs --serve               # 跑完 HTTP 冒烟后常驻服务
 *   node scripts/smoke.mjs --check-disk 冒烟      # 断言数据目录里出现该关键字
 *   node scripts/smoke.mjs --root <目录>          # 指定数据目录（默认临时目录）
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

register('./stub-loader.mjs', import.meta.url)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const keepServing = process.argv.includes('--serve')
const checkDiskKeyword = arg('--check-disk', null)
const port = Number(arg('--port', 7391))
const dataRoot = arg('--root', null)
  ? resolve(arg('--root', null))
  : mkdtempSync(join(tmpdir(), 'dsh-mind-smoke-'))
const temporaryRoot = !process.argv.includes('--root')

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  \u2713 ${label}`)
}

// ---------------------------------------------------------------- 宿主替身 --

const { apply } = await import(pathToFileURL(join(root, 'dsh', 'index.js')).href)
const routes = []
// 与 verify.mjs 相同的严格替身：复刻 Harness「同一精确路径只能登记一次」的契约，
// 否则「同路径分别注册 GET 与 POST」会让真实 Harness 里的 apply 抛错、插件全部接口 404。
const ctx = {
  connection: {
    fetch: {
      register(route) {
        if (routes.some((item) => item.path === route.path)) {
          throw new Error(`connection: exact Fetch route "${route.path}" is already registered`)
        }
        routes.push(route)
        return () => routes.splice(routes.indexOf(route), 1)
      }
    }
  },
  // Agent 工具与系统提示的断言由 verify 负责；这里提供最小服务面，保持静默。
  tools: { register() { return () => {} } },
  systemPrompt: { section() { return () => {} } },
  inject() { return () => {} },
  effect(callback) { return callback() }
}
apply(ctx, { root: dataRoot })
await new Promise((resolve) => setTimeout(resolve, 250))

const duplicatePaths = routes.map((item) => item.path).filter((path, index, all) => all.indexOf(path) !== index)
if (duplicatePaths.length) {
  console.error(`[smoke] 路由路径重复：${duplicatePaths.join('、')}`)
  process.exit(1)
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`)
    const method = request.method.toUpperCase()
    const route = routes.find((item) => item.path === url.pathname && item.methods.includes(method))
    if (!route) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('Not found')
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const payload = Buffer.concat(chunks)
    const headers = {}
    if (request.headers['content-type']) headers['content-type'] = request.headers['content-type']
    if (payload.length) headers['content-length'] = String(payload.length)
    const result = await route.fetch(new Request(url, {
      method,
      headers,
      body: payload.length && method !== 'GET' && method !== 'HEAD' ? payload : undefined
    }))
    response.writeHead(result.status, Object.fromEntries(result.headers))
    if (!result.body) {
      response.end()
      return
    }
    response.end(Buffer.from(await result.arrayBuffer()))
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end(String((error && error.stack) || error))
  }
})

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${port}`
const APP_PAGE = `${origin}/api/dsh-mind-workbench/app/index.html`

async function get(path, init) {
  return fetch(`${origin}${path}`, init)
}

function readDiskDocument(id) {
  return JSON.parse(readFileSync(join(dataRoot, 'documents', `${id}.json`), 'utf8'))
}

// ------------------------------------------------------------- 1. HTTP 冒烟 --

if (checkDiskKeyword) {
  const files = readdirSync(join(dataRoot, 'documents')).filter((name) => name.endsWith('.json'))
  const hit = files.find((name) => readFileSync(join(dataRoot, 'documents', name), 'utf8').includes(checkDiskKeyword))
  assert.ok(hit, `数据目录里没有任何文档包含关键字「${checkDiskKeyword}」`)
  const stored = JSON.parse(readFileSync(join(dataRoot, 'documents', hit), 'utf8'))
  ok(`浏览器端的编辑已落盘：documents/${hit} 含「${checkDiskKeyword}」（${(statSync(join(dataRoot, 'documents', hit)).size / 1024).toFixed(1)} KiB）`)
  console.log(`\n[smoke] 落盘校验通过（${checks} 项）；数据目录：${dataRoot}`)
  if (temporaryRoot) rmSync(dataRoot, { recursive: true, force: true })
  process.exit(0)
}

console.log('[smoke] HTTP 冒烟')

const health = await (await get('/api/dsh-mind-workbench/health')).json()
assert.equal(health.ok, true)
assert.ok(health.files > 250, `静态路由数量异常：${health.files}`)
ok(`服务已启动于 ${origin}，托管 ${health.files} 条静态路由`)

const page = await get('/api/dsh-mind-workbench/app/index.html')
const pageHtml = await page.text()
assert.equal(page.status, 200)
assert.match(page.headers.get('content-type'), /text\/html/)
assert.ok(pageHtml.includes('bridge.js') && pageHtml.includes('window.takeOverApp = true'))
ok('入口页可访问且已开启接管模式')

// 画布源码重新构建后，分块名里的内容哈希会变（chunk-<hash>.js），所以从磁盘挑最大的那块，
// 不要在测试里写死文件名。
const bundleDirectory = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'app', 'dist', 'js')
const bigChunk = readdirSync(bundleDirectory)
  .filter((name) => /^chunk-[A-Za-z0-9]+\.js$/.test(name))
  .map((name) => ({ name, size: statSync(join(bundleDirectory, name)).size }))
  .sort((a, b) => b.size - a.size)[0]
assert.ok(bigChunk, 'app/dist/js 下应当存在画布的分块脚本')

for (const [path, type, minimum] of [
  ['/api/dsh-mind-workbench/app/bridge.js', /javascript/, 2000],
  ['/api/dsh-mind-workbench/app/dist/js/app.js', /javascript/, 40000],
  ['/api/dsh-mind-workbench/app/dist/js/chunk-vendors.js', /javascript/, 500000],
  [`/api/dsh-mind-workbench/app/dist/js/${bigChunk.name}`, /javascript/, 300000],
  ['/api/dsh-mind-workbench/app/dist/css/chunk-vendors.css', /text\/css/, 100000],
  ['/api/dsh-mind-workbench/app/dist/fonts/element-icons.woff', /font\/woff/, 20000],
  ['/api/dsh-mind-workbench/app/dist/logo.ico', /image\//, 1000],
  ['/api/dsh-mind-workbench/app/dist/img/asset.svg', /image\/svg/, 500]
]) {
  const response = await get(path)
  const body = await response.arrayBuffer()
  assert.equal(response.status, 200, `${path} 应为 200`)
  assert.match(response.headers.get('content-type'), type, `${path} 的 content-type 不正确`)
  assert.ok(body.byteLength >= minimum, `${path} 体积异常：${body.byteLength}`)
}
ok('画布运行所需的 JS / CSS / 字体 / 图标 / 非 ASCII 素材全部可访问')

assert.equal((await get('/api/dsh-mind-workbench/app/not-registered.js')).status, 404)
ok('未登记的静态路径返回 404')

// 画布启动链路：等效于 iframe 载入后 bridge.js 的第一件事。
const boot = await (await get('/api/dsh-mind-workbench/session')).json()
assert.equal(boot.documentId, 'default')
assert.equal(boot.language, 'zh')
assert.ok(boot.document.data.root, '首次访问必须自动建立默认文档')
assert.ok(Array.isArray(boot.document.data.root.children))
ok(`GET /session 返回画布启动数据（documentId=${boot.documentId}，language=${boot.language}）`)

// 自动保存链路：等效于画布改动后 bridge.js 的 POST。
const edited = JSON.parse(JSON.stringify(boot.document.data))
edited.root.data.text = '冒烟测试根节点'
edited.root.children.push({ data: { text: '冒烟子节点' }, children: [] })
const savedResponse = await get('/api/dsh-mind-workbench/session/data', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ documentId: 'default', data: edited })
})
assert.equal(savedResponse.status, 200)

const afterSave = await (await get('/api/dsh-mind-workbench/session')).json()
assert.equal(afterSave.document.data.root.data.text, '冒烟测试根节点')
assert.equal(afterSave.document.data.root.children.length, 1)
assert.equal(readDiskDocument('default').data.root.children[0].data.text, '冒烟子节点')
ok('POST /session/data 落盘，并能在下一次 GET /session 中读回（等效画布刷新）')

const preferences = await get('/api/dsh-mind-workbench/session/preferences', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ language: 'en', mindMapConfig: { readonly: true } })
})
assert.equal(preferences.status, 200)
const afterPreferences = await (await get('/api/dsh-mind-workbench/session')).json()
assert.equal(afterPreferences.language, 'en')
assert.deepEqual(afterPreferences.mindMapConfig, { readonly: true })
await get('/api/dsh-mind-workbench/session/preferences', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ language: 'zh' })
})
ok('POST /session/preferences 保存语言与实例化配置')

const documentApi = async (body) => (await get('/api/dsh-mind-workbench/documents', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})).json()

const created = await documentApi({ action: 'create', name: '冒烟文档' })
assert.equal(created.document.name, '冒烟文档')
assert.equal(created.documents.length, 2)
const renamed = await documentApi({ action: 'rename', id: created.activeDocumentId, name: '冒烟文档 v2' })
assert.equal(renamed.document.name, '冒烟文档 v2')
assert.equal(renamed.activeDocumentId, created.activeDocumentId)
const duplicated = await documentApi({ action: 'duplicate', id: created.activeDocumentId })
assert.notEqual(duplicated.activeDocumentId, created.activeDocumentId)
const imported = await documentApi({
  action: 'import',
  name: '冒烟导入',
  data: { root: { data: { text: '导入的根' }, children: [] }, theme: {}, layout: 'logicalStructure', config: {}, view: null }
})
assert.equal(imported.document.name, '冒烟导入')
const removed = await documentApi({ action: 'delete', id: imported.activeDocumentId })
assert.ok(!removed.documents.some((item) => item.id === imported.activeDocumentId))
const readBack = await (await get('/api/dsh-mind-workbench/documents')).json()
assert.ok(readBack.documents.some((item) => item.name === '冒烟文档 v2'))
ok(`文档管理全流程可用（当前 ${readBack.documents.length} 个文档：${readBack.documents.map((item) => item.name).join('、')}）`)

assert.equal((await get('/api/dsh-mind-workbench/documents', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'delete', id: 'default' })
})).status, 400)
ok('默认文档受保护（删除返回 400）')

assert.ok(statSync(join(dataRoot, 'state.json')).size > 0)
assert.ok(readdirSync(join(dataRoot, 'documents')).length >= 2)
ok(`数据目录结构正确（state.json + documents/）；位置：${dataRoot}`)

if (!keepServing) {
  server.close()
  console.log(`\n[smoke] HTTP 冒烟全部通过（${checks} 项）`)
  if (temporaryRoot) rmSync(dataRoot, { recursive: true, force: true })
  console.log('[smoke] 加 --serve 可常驻服务以配合 agent-browser 做界面冒烟')
  process.exit(0)
}

console.log(`\n[smoke] HTTP 冒烟通过（${checks} 项），服务常驻中`)
console.log(`SMOKE_READY ${APP_PAGE}`)
console.log(`SMOKE_DATA_ROOT ${dataRoot}`)
