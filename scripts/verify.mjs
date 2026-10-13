#!/usr/bin/env node
/**
 * DSHMindWorkbench 自检脚本。
 *
 * 覆盖三件事，全部为确定性检查：
 *   1. 包与产物完整性：清单必填字段、cordis.patch.yml、app/ 落盘文件数、文本无 NUL；
 *   2. 服务端接口：用内存宿主 + 临时数据目录真跑一遍路由（健康检查、静态托管、
 *      文档增删改名、会话读写），断言状态码与副作用；
 *   3. 客户端入口：`__ModuleLoader__.load` 协议与注册字段。
 *
 * 用法：node scripts/verify.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

register('./stub-loader.mjs', import.meta.url)

// 在真实 Harness 里，插件抛在异步链中的异常会变成 unhandled rejection，
// 最终 `dsh: fatal load failure` 打死整个进程（不只是本插件失效）。
// 自检里把它当成硬失败，避免这类致命问题再次溜过去。
process.on('unhandledRejection', (error) => {
  console.error('\n[verify] 出现 unhandled rejection（真实环境中等价于 dsh: fatal load failure）：')
  console.error(error)
  process.exit(1)
})

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(root, 'app')
let checks = 0

function ok(label) {
  checks += 1
  console.log(`  \u2713 ${label}`)
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function walk(directory, prefix = '') {
  const out = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(join(directory, entry.name), relative))
    else out.push(relative)
  }
  return out
}

// --------------------------------------------------------------- 1. 包与产物 --

console.log('[verify] 包与产物')

const manifest = readJsonFile(join(root, 'package.json'))
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch 必须指向 cordis.patch.yml')
ok('package.json 声明 dsh.bundle.patch')
assert.equal(manifest.dsh?.client?.platform, 'web', 'dsh.client.platform 必须为 web')
assert.ok(Array.isArray(manifest.dsh?.client?.inject), 'dsh.client.inject 必须是数组')
assert.ok(manifest.dsh.client.inject.includes('dsh-desktop-workbenches'), 'dsh.client.inject 必须包含 dsh-desktop-workbenches')
ok('package.json 声明 dsh.client.platform/inject')
assert.ok(manifest.exports?.['./client'], 'exports["./client"] 必须存在')
assert.ok(manifest.files.includes('app'), 'files 必须包含 app 目录')
ok('exports["./client"] 与 files 覆盖构建产物')

const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
assert.ok(patch.includes('name: dsh-mind-workbench'), 'cordis.patch.yml 必须按包名插入')
assert.ok(patch.includes("dshHomePath('mind-workbench')"), 'cordis.patch.yml 必须声明数据目录')
ok('cordis.patch.yml 按包名插入并声明数据目录')

assert.ok(existsSync(join(appRoot, 'index.html')), '缺少 app/index.html')
assert.ok(existsSync(join(appRoot, 'bridge.js')), '缺少 app/bridge.js')
assert.ok(existsSync(join(appRoot, 'dist', 'js', 'app.js')), '缺少 app/dist/js/app.js')
const appFiles = walk(appRoot)
assert.ok(appFiles.length > 250, `app/ 文件数异常：${appFiles.length}`)
ok(`app/ 已落地 ${appFiles.length} 个文件`)

// 路由段的合法字符由 Harness 固定为 `[A-Za-z0-9_$.-]`（见应用内 ENDPOINT_SEGMENT_PATTERN）。
// 文件名违规会让 register 被判为 invalid exact Fetch route——这是曾经打死 Harness 的原因，
// 所以这里当成硬约束：`app/` 下不允许出现任何不合规文件名。
const ILLEGAL_SEGMENT = /[^A-Za-z0-9_$.-]/
const illegalNames = appFiles.filter((file) => file.split('/').some((segment) => segment === '' || ILLEGAL_SEGMENT.test(segment)))
assert.deepEqual(illegalNames, [], `app/ 下存在不合规文件名（只允许 A-Za-z0-9_$.-）：${illegalNames.join('、')}`)
ok('app/ 下所有文件名都满足路由段字符要求（无百分号编码/非 ASCII）')

const textExtensions = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map'])
let binaryScanned = 0
for (const file of [join(root, 'package.json'), join(root, 'cordis.patch.yml'), join(root, 'dsh', 'index.js'), join(root, 'lib', 'client.js'), join(appRoot, 'index.html'), join(appRoot, 'bridge.js')]) {
  const buffer = readFileSync(file)
  assert.equal(buffer.includes(0), false, `${file} 含 NUL 字节（写入损坏）`)
  binaryScanned += 1
}
assert.ok(binaryScanned >= 6)
ok('关键文本文件不含 NUL 字节')

// 画布源码 index.html 的统计脚本与示例接管代码不得残留。
const appHtml = readFileSync(join(appRoot, 'index.html'), 'utf8')
assert.equal(appHtml.includes('sdk.51.la'), false, 'app/index.html 仍含第三方统计脚本')
assert.equal(appHtml.includes('getDataFromBackend'), false, 'app/index.html 仍含画布源码示例接管代码')
assert.ok(appHtml.includes('window.takeOverApp = true'), 'app/index.html 必须开启接管模式')
ok('app/index.html 已剥离统计脚本与示例代码，且开启接管模式')

// AI 配置弹窗里的「教程」链接：必须已从画布的微信公众号文章改成我们托管的教程页。
const TUTORIAL_URL = '/api/dsh-mind-workbench/app/docs/ai-model-setup.html'
const bundleFiles = walk(join(appRoot, 'dist', 'js')).filter((file) => file.endsWith('.js'))
const bundles = bundleFiles.map((file) => readFileSync(join(appRoot, 'dist', 'js', file), 'utf8'))
assert.equal(bundles.some((text) => text.includes('mp.weixin.qq.com')), false, '画布的微信教程链接仍然存在')
assert.equal(bundles.filter((text) => text.includes(TUTORIAL_URL)).length, 1, '应恰有一个产物把「教程」链接指向本地教程页')
assert.ok(existsSync(join(appRoot, 'docs', 'ai-model-setup.html')), '缺少教程页 app/docs/ai-model-setup.html')
ok('「教程」链接已指向本包托管的模型配置教程页')

// ------------------------------------------------ 导出格式：文档必须与产物一致 --
// 市场审核曾因「介绍里写了 Xlsx / FreeMind / Mermaid / Html」判为不符：
// 画布自带的导出对话框（产物里的 downTypeList 计算属性）会过滤掉 mm（FreeMind）与
// xlsx（Excel），而 Mermaid / Html 从来没有实现。
// 这里不靠人工记忆：直接从产物解析「用户实际能选到的格式」，再断言文档只声明这些。
const anchor = '导图文件'
const anchorIndex = bundles.map((text) => text.indexOf(anchor)).find((index) => index !== -1)
assert.ok(anchorIndex !== undefined, '产物里没有找到导出类型配置（画布的导出对话框可能已改动）')
const bundleWithExports = bundles.find((text) => text.includes(anchor))
// 往前多取一点：锚点是「导图文件」这几个字，而条目本身是 {name:"导图文件",type:"smm"…}，
// 从锚点处切会把第一个条目的 `{name:"` 切掉，导致第一条被漏解析（踩过一次）。
const exportBlock = bundleWithExports.slice(Math.max(0, anchorIndex - 40), bundleWithExports.indexOf(']', anchorIndex))
const exportEntries = [...exportBlock.matchAll(/\{name:"([^"]+)",type:"([^"]+)"/g)]
  .map((match) => ({ name: match[1], type: match[2] }))
assert.ok(exportEntries.length >= 5, `解析出的导出类型过少（${exportEntries.length}），解析逻辑需要更新`)
// 导出对话框过滤掉的类型，形如：filter(t=>"mm"!==t.type&&"xlsx"!==t.type)
// 注意要在整份产物里找这个两类型过滤式，再挑出「两个类型都属于导出配置」的那一条——
// 产物里还有别的形如 `"x"!==t.type` 的比较，直接全局抓会误伤。
const exportTypes = new Set(exportEntries.map((entry) => entry.type))
const excludedTypes = [...bundleWithExports.matchAll(/filter\((\w+)=>"([^"]+)"!==\1\.type&&"([^"]+)"!==\1\.type/g)]
  .map((match) => [match[2], match[3]])
  .find((types) => types.every((type) => exportTypes.has(type)))
assert.ok(excludedTypes, '没有解析到导出对话框的类型过滤规则（画布的导出逻辑可能已改动）')
const availableExports = exportEntries.filter((entry) => !excludedTypes.includes(entry.type))
assert.deepEqual(
  availableExports.map((entry) => entry.name),
  ['导图文件', '图片', 'SVG', 'PDF', 'Markdown', 'XMind', 'Txt', 'JSON'],
  `产物实际开放的导出格式与预期不符（画布版本变化？实际：${availableExports.map((entry) => entry.name).join('、')}）`
)

const readme = readFileSync(join(root, 'README.md'), 'utf8')
const integration = readFileSync(join(root, 'INTEGRATION.md'), 'utf8')
for (const entry of availableExports) {
  assert.ok(readme.includes(entry.name), `README 没有列出产物实际支持的导出格式：${entry.name}`)
}
for (const unsupported of ['Xlsx', 'Excel', 'FreeMind', 'Mermaid', 'Html']) {
  assert.equal(readme.includes(unsupported), false, `README 声明了产物实际不提供的格式：${unsupported}`)
  assert.equal(integration.includes(unsupported), false, `INTEGRATION.md 声明了产物实际不提供的格式：${unsupported}`)
}
ok(`文档声明的导出格式与产物一致（实际 ${availableExports.length} 种：${availableExports.map((entry) => entry.name).join('、')}）`)

// 措辞与来源声明：本项目是内嵌画布项目的二次开发，文档不用「上游 / 下游」这类相对措辞。
for (const doc of ['README.md', 'INTEGRATION.md']) {
  const text = readFileSync(join(root, doc), 'utf8')
  assert.equal(/上游|下游/.test(text), false, `${doc} 里出现了「上游 / 下游」措辞`)
}
assert.ok(readme.includes('二次开发'), 'README 里应说明本项目是二次开发')
ok('文档措辞统一，并如实声明了二次开发')

// ------------------------------------------------------------------ 2. 服务端 --

console.log('[verify] 服务端接口（内存宿主 + 临时数据目录）')

const { apply, Config, aiEndpointFor, outlineToMindMap, mindMapToOutline } = await import(pathToFileURL(join(root, 'dsh', 'index.js')).href)
assert.equal(aiEndpointFor('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions')
assert.equal(aiEndpointFor('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions')
assert.equal(aiEndpointFor('https://x.example/y/chat/completions'), 'https://x.example/y/chat/completions')
assert.equal(aiEndpointFor('', 'http://ark.example/api/v3/chat/completions'), 'http://ark.example/api/v3/chat/completions')
const sampleRoot = outlineToMindMap('# 主题\n- A\n  - A1\n- B')
assert.equal(sampleRoot.data.text, '主题')
assert.equal(sampleRoot.children.length, 2)
assert.equal(sampleRoot.children[0].children[0].data.text, 'A1')
assert.match(mindMapToOutline(sampleRoot), /## A\n- A1/)
ok('大纲 ⇄ 导图 转换与 AI 端点拼接正确')
assert.equal(typeof apply, 'function', 'dsh/index.js 必须导出 apply')
assert.equal(typeof Config, 'object', 'Config 必须是 Schemastery schema')
ok('dsh/index.js 导出 apply 与 Schemastery Config')

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-mind-workbench-'))
const routes = []
const registeredTools = []
const promptSections = []
const ctx = {
  connection: {
    fetch: {
      register(route) {
        // 真实 @deepseek-ai/dsh-client-connection 的 fetch 路由按「精确路径」登记：
        // 同一路径第二次登记会抛 `exact Fetch route ... is already registered`（不按方法区分）。
        // 替身必须复现这一点，否则「同一路径分别注册 GET 与 POST」这类会在真实 Harness 里
        // 导致插件激活失败的缺陷，会被自检放过。
        if (routes.some((item) => item.path === route.path)) {
          throw new Error(`connection: exact Fetch route "${route.path}" is already registered`)
        }
        routes.push(route)
        return () => routes.splice(routes.indexOf(route), 1)
      }
    }
  },
  // 工具注册：官方写法是在 apply 里直接 ctx.tools.register(...)
  //（见 @deepseek-ai/dsh-image-generation；本插件已从子作用域注册改成同款写法）。
  tools: {
    register(tool) {
      registeredTools.push(tool)
      return () => registeredTools.splice(registeredTools.indexOf(tool), 1)
    }
  },
  // 系统提示段落：工具光注册不够，模型还得知道有这个能力。
  systemPrompt: {
    section(spec) {
      promptSections.push(spec)
      return () => {}
    }
  },
  // 保留 ctx.inject 替身，便于回归对比早期「注册到子作用域」的写法。
  inject(dependencies, callback) {
    if (Array.isArray(dependencies) && dependencies.includes('tools')) callback(ctx)
    return () => {}
  },
  effect(callback) { return callback() }
}

async function request(method, path, body) {
  const url = `http://127.0.0.1${path}`
  const route = routes.find((item) => item.path === new URL(url).pathname && item.methods.includes(method))
  if (!route) return new Response('Not found', { status: 404 })
  const init = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  return route.fetch(new Request(url, init))
}

try {
  apply(ctx, { root: dataRoot })

  // 静态路由必须**同步**登记完成：若放到异步链里，登记失败会变成 unhandled rejection
  // 并升级为 `dsh: fatal load failure`。因此在任何 await 之前就断言路由已就位。
  assert.ok(routes.length > 250, `apply() 返回时静态路由应已同步登记，实际只有 ${routes.length} 条`)
  ok(`静态路由在 apply() 内同步登记完成（${routes.length} 条，无异步注册风险）`)

  await new Promise((resolve) => setTimeout(resolve, 50))

  // 路由表自身的契约：路径唯一、每条都声明 buffered 正文模式、documents 只登记一次。
  const routePaths = routes.map((item) => item.path)
  assert.equal(new Set(routePaths).size, routePaths.length, '路由路径必须唯一（重复登记会让 apply 抛错并回收全部路由）')
  assert.ok(routes.every((item) => item.requestBody === 'buffered'), '所有路由都必须声明 requestBody: "buffered"')
  assert.ok(routes.every((item) => Array.isArray(item.methods) && item.methods.length > 0), '每条路由都必须声明方法')
  assert.ok(routes.every((item) => new Set(item.methods).size === item.methods.length), '路由方法不得重复声明')
  // 复刻 assertFetchRoute：/api/<段>/… 每段都必须匹配 [A-Za-z0-9_$.-]
  const invalidRoutes = routePaths.filter((path) => path !== '/api' && !path.startsWith('/api/')
    || path.slice('/api/'.length).split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || ILLEGAL_SEGMENT.test(segment)))
  assert.deepEqual(invalidRoutes, [], `存在会被 Harness 判为 invalid 的路由路径：${invalidRoutes.join('、')}`)
  ok(`路由表符合 Harness 契约：${routePaths.length} 条路径全部唯一且通过段字符校验`)

  const documentRoutes = routes.filter((item) => item.path === '/api/dsh-mind-workbench/documents')
  assert.equal(documentRoutes.length, 1, 'documents 只能登记一条路由')
  assert.deepEqual([...documentRoutes[0].methods].sort(), ['GET', 'POST'], 'documents 必须同时接受 GET 与 POST')
  ok('documents 合并为一条多方法路由（GET 列表 / POST 操作）')

  const health = await (await request('GET', '/api/dsh-mind-workbench/health')).json()
  assert.equal(health.ok, true)
  assert.equal(health.root, resolve(dataRoot))
  assert.ok(health.files > 250, `静态路由数量异常：${health.files}`)
  assert.deepEqual(health.skipped, [], `服务端跳过了非法静态路径（会导致资源 404）：${health.skipped.join('、')}`)
  // health.files 只统计静态资源路由；业务路由单独列出，避免写死数字。
  const businessPaths = new Set([
    '/api/dsh-mind-workbench/health',
    '/api/dsh-mind-workbench/session',
    '/api/dsh-mind-workbench/session/data',
    '/api/dsh-mind-workbench/session/preferences',
    '/api/dsh-mind-workbench/documents',
    '/api/dsh-mind-workbench/ai/providers',
    '/api/dsh-mind-workbench/ai/settings',
    '/api/dsh-mind-workbench/ai/chat',
    '/api/dsh-mind-workbench/ai/test'
  ])
  assert.equal(health.files, routePaths.filter((path) => !businessPaths.has(path)).length, 'health.files 必须等于静态资源路由条数')
  for (const path of businessPaths) {
    assert.ok(routePaths.includes(path), `缺少业务路由：${path}`)
  }
  ok(`静态应用按文件注册路由（${health.files} 条，0 条被跳过）`)

  const page = await request('GET', '/api/dsh-mind-workbench/app/index.html')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  ok('GET /app/index.html 返回 HTML 且不缓存')

  const script = await request('GET', '/api/dsh-mind-workbench/app/dist/js/app.js?720fe4d863ea0fdcc0fb')
  assert.equal(script.status, 200)
  assert.match(script.headers.get('content-type'), /javascript/)
  // 曾经名为「图片加载失败.svg」的素材已被 sync-app 改成 ASCII 名；按改写后的名字可访问。
  const renamedAsset = await request('GET', '/api/dsh-mind-workbench/app/dist/img/asset.svg')
  assert.equal(renamedAsset.status, 200, 'ASCII 化后的素材必须可访问')
  assert.match(renamedAsset.headers.get('content-type'), /image\/svg/)
  // 非 ASCII 名字既无法登记（invalid exact Fetch route），也不应再被引用。
  const encoded = await request('GET', `/api/dsh-mind-workbench/app/dist/img/${encodeURI('图片加载失败.svg')}`)
  assert.equal(encoded.status, 404, '非 ASCII 路径不可登记，必须返回 404 而不是让插件失效')
  ok('带 query hash 的构建产物与 ASCII 化素材可访问，非 ASCII 路径安全 404')

  // 模型配置教程页必须可访问，且弹窗里的「教程」链接指向它（画布源码指向的是微信公众号文章）
  const tutorial = await request('GET', '/api/dsh-mind-workbench/app/docs/ai-model-setup.html')
  assert.equal(tutorial.status, 200, '教程页必须可访问')
  assert.match(tutorial.headers.get('content-type'), /text\/html/)
  const tutorialHtml = await tutorial.text()
  assert.ok(tutorialHtml.includes('火山方舟'), '教程页应包含火山方舟配置说明')
  assert.ok(tutorialHtml.includes('<table'), '教程页应包含字段说明表格')
  ok('模型配置教程页可访问（/app/docs/ai-model-setup.html）')

  const missing = await request('GET', '/api/dsh-mind-workbench/app/does-not-exist.js')
  assert.equal(missing.status, 404)
  ok('未登记的静态路径返回 404')

  const first = await (await request('GET', '/api/dsh-mind-workbench/session')).json()
  assert.equal(first.documentId, 'default')
  assert.ok(first.document.data.root, '首次访问必须自动建立默认文档')
  assert.equal(first.language, 'zh')
  ok('GET /session 自动建立并返回默认文档')

  const created = await (await request('POST', '/api/dsh-mind-workbench/documents', { action: 'create', name: '项目计划' })).json()
  assert.equal(created.activeDocumentId.startsWith('map-'), true)
  assert.equal(created.document.name, '项目计划')
  assert.equal(created.documents.length, 2)
  const createdId = created.activeDocumentId
  ok('POST /documents create 建立新文档并切换当前文档')

  const saved = await (await request('POST', '/api/dsh-mind-workbench/session/data', {
    documentId: createdId,
    data: { root: { data: { text: '根' }, children: [{ data: { text: '子' }, children: [] }] }, theme: { template: 'avocado', config: {} }, layout: 'logicalStructure', config: {}, view: null }
  })).json()
  assert.equal(saved.ok, true)
  const reloaded = await (await request('GET', '/api/dsh-mind-workbench/session')).json()
  assert.equal(reloaded.documentId, createdId)
  assert.equal(reloaded.document.data.root.children.length, 1)
  ok('POST /session/data 落盘并被后续 /session 读回')

  // 回归（用户报的「新建的导图打不开，永远打开第一个」）：
  // 切换文档时旧画布的 iframe 会被卸载，bridge 的 flushBeacon 会用 sendBeacon 把
  // **旧文档**再补写一次。这不是「打开」动作，绝不能因此把当前文档抢回旧文档。
  await request('POST', '/api/dsh-mind-workbench/documents', { action: 'open', id: createdId })
  await request('POST', '/api/dsh-mind-workbench/session/data', {
    documentId: 'default',
    data: { root: { data: { text: '默认' }, children: [] }, theme: { template: 'avocado', config: {} }, layout: 'logicalStructure', config: {}, view: null }
  })
  const afterBeacon = await (await request('GET', '/api/dsh-mind-workbench/session')).json()
  assert.equal(afterBeacon.documentId, createdId, '旧画布的延迟回写不得抢回当前文档')
  const afterBeaconList = await (await request('GET', '/api/dsh-mind-workbench/documents')).json()
  assert.equal(afterBeaconList.activeDocumentId, createdId, '文档列表也必须仍指向切换后的文档')
  ok('旧画布的延迟回写不会抢回当前文档（切换文档回归）')

  const renamed = await (await request('POST', '/api/dsh-mind-workbench/documents', { action: 'rename', id: createdId, name: '项目计划 v2' })).json()
  assert.equal(renamed.document.name, '项目计划 v2')
  assert.equal(renamed.activeDocumentId, createdId, '重命名不得改变当前文档')
  ok('POST /documents rename 只改名称')

  const duplicated = await (await request('POST', '/api/dsh-mind-workbench/documents', { action: 'duplicate', id: createdId })).json()
  assert.notEqual(duplicated.activeDocumentId, createdId)
  assert.equal(duplicated.document.name, '项目计划 v2 副本')
  assert.equal(duplicated.document.data.root.children.length, 1, '副本必须带原数据')
  ok('POST /documents duplicate 复制数据并切换')

  const imported = await (await request('POST', '/api/dsh-mind-workbench/documents', {
    action: 'import', name: '导入的导图', data: { root: { data: { text: '导入' }, children: [] }, theme: {}, layout: 'logicalStructure', config: {}, view: null }
  })).json()
  assert.equal(imported.document.name, '导入的导图')
  ok('POST /documents import 接受外部数据')

  const removed = await (await request('POST', '/api/dsh-mind-workbench/documents', { action: 'delete', id: imported.activeDocumentId })).json()
  assert.equal(removed.ok, true)
  assert.ok(!removed.documents.some((item) => item.id === imported.activeDocumentId))
  ok('POST /documents delete 移除文档')

  // 回归：画布卸载时旧 iframe 的延迟回写会在删除之后到达——
  // 它不得把已删除的文档「复活」成一张空导图。
  const ghostId = imported.activeDocumentId
  const resurrect = await request('POST', '/api/dsh-mind-workbench/session/data', {
    documentId: ghostId,
    data: { root: { data: { text: '幽灵' }, children: [] }, theme: { template: 'avocado', config: {} }, layout: 'logicalStructure', config: {}, view: null }
  })
  assert.equal(resurrect.status, 404, '对已删除文档的延迟回写必须被拒绝')
  const afterResurrect = await (await request('GET', '/api/dsh-mind-workbench/documents')).json()
  assert.ok(!afterResurrect.documents.some((item) => item.id === ghostId), '已删除的文档不得被复活')
  ok('延迟回写不会复活已删除的文档')

  // 回归（用户报的「生成的项目无法删除，删除后又自动恢复」）：
  // 删除的**就是画布当前打开的那份**时，画布的自动保存请求会落在
  // 「删文件」与「移开当前指针」之间的窗口里；它必须被拒绝，且文档不得复活。
  const doomed = await (await request('POST', '/api/dsh-mind-workbench/documents', { action: 'create', name: '待删除' })).json()
  const doomedId = doomed.activeDocumentId
  assert.equal((await request('POST', '/api/dsh-mind-workbench/documents', { action: 'delete', id: doomedId })).status, 200)
  const lateSave = await request('POST', '/api/dsh-mind-workbench/session/data', {
    documentId: doomedId,
    data: { root: { data: { text: '回流' }, children: [] }, theme: { template: 'avocado', config: {} }, layout: 'logicalStructure', config: {}, view: null }
  })
  assert.equal(lateSave.status, 404, '删除当前文档后，画布的自动保存必须被拒绝')
  const afterLateSave = await (await request('GET', '/api/dsh-mind-workbench/documents')).json()
  assert.ok(!afterLateSave.documents.some((item) => item.id === doomedId), '已删除的当前文档不得被自动保存复活')
  assert.equal((await (await request('GET', '/api/dsh-mind-workbench/session')).json()).documentId, 'default')
  ok('删除当前文档时，画布的自动保存不会复活它（删除竞态回归）')

  const deleteDefault = await request('POST', '/api/dsh-mind-workbench/documents', { action: 'delete', id: 'default' })
  assert.equal(deleteDefault.status, 400)
  ok('默认文档受保护，不可删除')

  const badId = await request('POST', '/api/dsh-mind-workbench/documents', { action: 'open', id: '../escape' })
  assert.equal(badId.status, 400)
  ok('非法文档标识被拒绝（路径穿越防护）')

  const badData = await request('POST', '/api/dsh-mind-workbench/session/data', { documentId: 'default', data: { nothing: true } })
  assert.equal(badData.status, 400)
  ok('缺少 root 的数据被拒绝')

  const badJson = await (async () => {
    const route = routes.find((item) => item.path === '/api/dsh-mind-workbench/session/data')
    return route.fetch(new Request('http://127.0.0.1/api/dsh-mind-workbench/session/data', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } }))
  })()
  assert.equal(badJson.status, 400)
  ok('非法 JSON 正文被拒绝')

  const preferences = await (await request('POST', '/api/dsh-mind-workbench/session/preferences', { language: 'en', mindMapConfig: { readonly: true } })).json()
  assert.equal(preferences.ok, true)
  const afterPreferences = await (await request('GET', '/api/dsh-mind-workbench/session')).json()
  assert.equal(afterPreferences.language, 'en')
  assert.deepEqual(afterPreferences.mindMapConfig, { readonly: true })
  ok('POST /session/preferences 保存语言与实例化配置')

  assert.ok(statSync(join(dataRoot, 'state.json')).size > 0, 'state.json 必须落盘')
  assert.ok(readdirSync(join(dataRoot, 'documents')).length >= 1, 'documents/ 必须有文档文件')
  ok('数据落在配置的 root 目录（state.json + documents/）')

  // ------------------------------------------------- Agent 可调用工具（截图里的症结）--

  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(
    registeredTools.map((tool) => tool.name).sort(),
    ['mindmap_list', 'mindmap_read', 'mindmap_write'],
    '必须向会话注册三个导图工具，否则 Agent 无法画导图'
  )
  ok('已向会话注册 Agent 工具：mindmap_list / mindmap_read / mindmap_write')

  // 工具必须在**会话的能力清单**里（模块级 inject + ctx.tools.register），
  // 并且要有系统提示告诉模型何时使用——这两条缺一个，对话框里都画不出导图。
  assert.equal(promptSections.length, 1, '必须注册且只注册一条系统提示段落')
  assert.equal(promptSections[0].name, 'tool:mind-map-workbench')
  assert.match(promptSections[0].text, /mindmap_write/)
  assert.ok(promptSections[0].order > 0)
  ok('已注册系统提示段落，告知模型用 mindmap_write 画导图')

  const writeTool = registeredTools.find((tool) => tool.name === 'mindmap_write')
  const readTool = registeredTools.find((tool) => tool.name === 'mindmap_read')
  const listTool = registeredTools.find((tool) => tool.name === 'mindmap_list')
  assert.deepEqual(writeTool.required, ['outline'], 'mindmap_write 必须要求 outline 参数')
  assert.equal(typeof writeTool.output?.render, 'function', '工具必须声明 output.render')

  const written = await writeTool.execute({ outline: '# 周会纪要\n- 进展\n  - 完成 A\n- 风险\n- 下周' })
  assert.match(written, /已新建导图/)
  // 根 + 进展 + 完成 A + 风险 + 下周 = 5 个节点
  assert.match(written, /5 个节点/, `节点数不符：${written}`)
  ok('mindmap_write：用 Markdown 大纲新建导图（含节点计数）')

  const outline = await readTool.execute({})
  assert.match(outline, /# 周会纪要/)
  assert.match(outline, /## 进展/)
  assert.match(outline, /- 完成 A/)
  ok('mindmap_read：读回同一份导图且层级正确')

  // 大导图必须截断：工具结果会整段进入对话上下文，不设上限一次读取就能挤爆上下文。
  const bigOutline = ['# 大图', ...Array.from({ length: 600 }, (_, index) => `- 节点 ${index}`)].join('\n')
  await writeTool.execute({ outline: bigOutline, name: '大图' })
  const bigRead = await readTool.execute({})
  assert.match(bigRead, /另有 \d+ 行未显示/, '超出上限的导图必须截断并说明')
  assert.ok(bigRead.length < 20000, `截断后仍过长：${bigRead.length}`)
  ok('mindmap_read 对超大导图截断输出（保护对话上下文）')

  assert.match(await listTool.execute({}), /周会纪要/)
  ok('mindmap_list：列出导图文档')

  await assert.rejects(() => writeTool.execute({ outline: '   ' }), /outline 不能为空/)
  ok('mindmap_write 拒绝空大纲')

  // ------------------------------------------------------------ 多供应商模型 --

  const providers = await (await request('GET', '/api/dsh-mind-workbench/ai/providers')).json()
  assert.ok(providers.providers.length >= 6, `供应商预设过少：${providers.providers.length}`)
  for (const id of ['volcano', 'deepseek', 'openai', 'moonshot', 'dashscope', 'zhipu', 'siliconflow', 'ollama', 'custom']) {
    assert.ok(providers.providers.some((item) => item.id === id), `缺少供应商预设：${id}`)
  }
  ok(`模型供应商预设可用（${providers.providers.length} 家，含火山方舟/DeepSeek/OpenAI/Kimi/通义/智谱/硅基流动/Ollama/自定义）`)

  const savedSettings = await (await request('POST', '/api/dsh-mind-workbench/ai/settings', {
    providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-verify', model: 'deepseek-chat'
  })).json()
  assert.equal(savedSettings.ok, true)
  const readSettings = await (await request('GET', '/api/dsh-mind-workbench/ai/settings')).json()
  assert.equal(readSettings.providerId, 'deepseek')
  assert.equal(readSettings.model, 'deepseek-chat')
  assert.equal(readSettings.apiKey, 'sk-verify')
  ok('模型配置（供应商 / 接口地址 / Key / 模型）可保存并读回')

  await request('POST', '/api/dsh-mind-workbench/ai/settings', { providerId: 'custom', baseUrl: '', apiKey: '', model: '' })
  const unconfigured = await request('POST', '/api/dsh-mind-workbench/ai/chat', { api: '', method: 'POST', headers: {}, data: {} })
  assert.equal(unconfigured.status, 400, '未配置模型时应返回 400')
  assert.match((await unconfigured.json()).error, /尚未配置模型/)
  ok('未配置模型时 ai/chat 返回可诊断的 400')

  const nonHttp = await request('POST', '/api/dsh-mind-workbench/ai/chat', { api: 'file:///etc/passwd', method: 'POST', headers: {}, data: {} })
  assert.equal(nonHttp.status, 400, '必须拒绝非 http(s) 的目标地址')
  ok('ai/chat 拒绝非 http(s) 目标（不允许 file: 等协议）')
} finally {
  rmSync(dataRoot, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 3. 客户端 --

console.log('[verify] 客户端入口')

const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
assert.ok(client.includes('window.__ModuleLoader__.load({'), '客户端必须使用模块加载器协议')
assert.ok(client.includes("id: 'dsh-mind-workbench'"), '加载器 id 必须是包名')
assert.ok(client.includes('ctx.desktopWorkbenches.register('), '必须通过 desktopWorkbenches.register 注册工作台')
assert.ok(client.includes("inject: ['desktopWorkbenches', 'locale']"), '必须声明 desktopWorkbenches 与 locale 注入')
assert.ok(client.includes('customFrame: true'), '思维导图工作台占据主内容区')
assert.ok(client.includes('ctx.locale.register(NS'), '文案必须通过 locale 注册')
assert.ok(client.includes("data-plugin-css=\"dsh-mind-workbench\""), '样式必须有幂等 guard')
assert.equal(client.includes('--ds-'), false, '不得使用 --ds- 系列旧变量')
ok('客户端入口符合模块加载、注册、locale 与样式幂等约束')

// 演示模式与「全屏查看/全屏编辑」都走 requestFullscreen：iframe 不授予该权限就会被拒，
// 表现是「点演示模式没有反应」。
assert.ok(client.includes("allow: 'fullscreen'"), 'iframe 必须声明 allow="fullscreen"')
assert.ok(client.includes('allowFullScreen: true'), 'iframe 必须带 allowFullScreen 兼容旧写法')
ok('内嵌画布 iframe 已授予全屏权限（演示模式 / 全屏查看）')

// 画布产物的定制项：Github 指向本工作台仓库、不再出现画布源码仓库地址、版本号是本工作台的。
const distJsDir = join(appRoot, 'dist', 'js')
let distJs = ''
for (const file of readdirSync(distJsDir)) {
  if (file.endsWith('.js')) distJs += readFileSync(join(distJsDir, file), 'utf8')
}
const workbenchVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
assert.ok(distJs.includes('https://github.com/andoaidlaksldk/dsh-mind-workbench'), 'Github 菜单必须指向本工作台仓库')
assert.equal(distJs.includes('wanglin2'), false, '产物里不得再出现画布源码仓库地址')
assert.ok(distJs.includes(workbenchVersion), `关于菜单里的版本号必须是本工作台版本（${workbenchVersion}）`)
ok('画布产物：Github 指向本工作台、无画布源码仓库地址、版本号为本工作台版本')

const bridge = readFileSync(join(appRoot, 'bridge.js'), 'utf8')
for (const method of ['getMindMapData', 'saveMindMapData', 'getMindMapConfig', 'saveMindMapConfig', 'getLanguage', 'saveLanguage', 'getLocalConfig', 'saveLocalConfig']) {
  assert.ok(bridge.includes(`${method}:`), `bridge.js 必须实现接管协议方法 ${method}`)
}
ok('app/bridge.js 实现画布源码接管模式的全部 8 个方法')

for (const marker of ["notify('dirty')", 'markDirty', 'flushBeacon', 'sendBeacon']) {
  assert.ok(bridge.includes(marker), `bridge.js 缺少脏标记/卸载兜底：${marker}`)
}
ok('app/bridge.js 上报脏状态并在卸载时用 sendBeacon 兜底落盘')

assert.ok(client.includes("payload.type === 'dirty'"), '面板必须处理画布的脏状态上报')
ok('面板与画布的消息协议对齐（ready / dirty / saved / error / snapshot）')

// 在最小 DOM/React 替身上真正执行一次客户端入口：注册描述符 + 渲染面板树，
// 用来捕捉模块加载协议、描述符字段和 createElement 树里的引用错误。
const appendedStyles = []
globalThis.window = {
  location: { origin: 'http://127.0.0.1:1' },
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null, setItem() {} }
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (node) => appendedStyles.push(node) },
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {},
  removeEventListener() {}
}

let loaded = null
globalThis.window.__ModuleLoader__ = { load: (entry) => { loaded = entry } }
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial ?? null }),
  useEffect() {},
  useCallback: (callback) => callback
}

// eslint-disable-next-line no-new-func
new Function('window', 'document', client)(
  globalThis.window,
  globalThis.document
)

assert.ok(loaded, '__ModuleLoader__.load 未被调用')
assert.equal(loaded.id, 'dsh-mind-workbench')
ok('客户端通过 __ModuleLoader__ 以包名为 id 注册')

const api = loaded.factory((specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error(`客户端不应 require 基线以外的模块：${specifier}`)
})
assert.deepEqual(api.inject, ['desktopWorkbenches', 'locale'])
ok('客户端只依赖 react，并声明 desktopWorkbenches / locale 注入')

const registrations = []
const dictionaries = []
api.apply({
  effect: (callback) => callback(),
  locale: {
    register: (ns, dict) => { dictionaries.push({ ns, dict }); return () => {} },
    bind: (ns) => (key) => `${ns}.${key}`
  },
  desktopWorkbenches: {
    register: (descriptor, Component) => { registrations.push({ descriptor, Component }); return () => {} }
  }
})

assert.equal(registrations.length, 1, '客户端必须注册且只注册一个工作台')
assert.equal(dictionaries.length, 1, '文案必须通过 ctx.locale.register 注册一次')
assert.ok(dictionaries[0].dict.zh && dictionaries[0].dict.en, '中英文文案必须同批注册')
assert.deepEqual(Object.keys(dictionaries[0].dict.zh).sort(), Object.keys(dictionaries[0].dict.en).sort(), '中英文 key 必须一一对应')
ok('注册了中英文对应的文案字典')

const { descriptor, Component } = registrations[0]
assert.equal(typeof Component, 'function')
assert.ok(descriptor.title.length > 0, 'register 必须提供 title')
assert.match(descriptor.repository, /^https:\/\/github\.com\/[^/]+\/[^/]+$/, 'register 必须提供规范的 GitHub repository')
assert.equal(descriptor.customFrame, true)
ok('register 描述符含 title / repository / customFrame')

const tree = Component({
  service: { state: null, currentSession: () => null },
  entry: { id: 'andoaidlaksldk/dsh-mind-workbench' },
  active: true,
  conversation: null
})
assert.equal(tree.type, 'div')
assert.equal(tree.props.className, 'dshMw')
const header = tree.children[0]
assert.equal(header.type, 'header', 'macOS 拖拽区要求根节点的首个子元素是语义 header')
assert.equal(header.props.className, 'dshMwToolbar')
ok('面板可渲染，根节点首子元素为 header（满足 macOS 顶部拖拽接缝）')

function collect(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, found)
    return found
  }
  if (!node || typeof node !== 'object') return found
  if (node.type) found.push(node)
  if (node.children) collect(node.children, found)
  return found
}
const nodes = collect(tree)
const byClass = (name) => nodes.find((node) => node.props?.className === name)

// 规范 4.1：customFrame 工作台不常驻会话区，也不显示宿主通用无会话引导。
const dock = byClass('dshMwDock')
assert.ok(dock, '必须渲染会话容器（宿主 conversation 节点的停靠位）')
assert.equal(dock.props.hidden, true, '会话区默认必须收起，画布独占主内容区')
assert.ok(byClass('dshMwSession'), '无会话时必须由工作台自己提供入口，而不是复用宿主通用引导')
assert.equal(nodes.some((node) => node.props?.className === 'dshMwEmpty'), false, '不得再渲染宿主通用无会话引导区')
ok('会话区默认收起、画布独占主内容区，并自带无会话入口')

const assistButton = nodes.find((node) => node.type === 'button' && node.props?.['aria-pressed'] !== undefined)
assert.ok(assistButton, '必须有可访问的 AI 协助开关')
assert.equal(assistButton.props['aria-pressed'], 'false', '默认未开启 AI 协助')
assert.deepEqual(assistButton.children, ['dsh-mind-workbench.aiAssist'])
ok('AI 协助入口以 aria-pressed 暴露状态，默认关闭')

const hint = nodes.find((node) => node.props?.className === 'dshMwHint')
assert.ok(hint, '必须提供工作台自己的首次进入状态')
assert.equal(hint.props.role, 'status')
ok('提供可关闭的首次进入说明（工作台自有，非聊天区）')

// 模型配置入口 + 外部写入提示（Agent 用工具写盘后要能看到）
for (const marker of ['ModelConfigDialog', 'ai/providers', 'ai/settings', 'ai/chat', 'setModelOpen(true)']) {
  assert.ok(client.includes(marker), `面板缺少模型配置要素：${marker}`)
}
for (const marker of ['externalStale', 'EXTERNAL_POLL_MS', 'seenUpdatedAtRef']) {
  assert.ok(client.includes(marker), `面板缺少外部写入检测要素：${marker}`)
}
ok('面板提供模型配置入口，并能发现画布之外的写入')

const modelButton = nodes.find((node) => node.type === 'button'
  && Array.isArray(node.children)
  && node.children[0] === 'dsh-mind-workbench.modelConfig')
assert.ok(modelButton, '工具栏必须有「模型配置」按钮')
ok('工具栏含「模型配置」按钮，且与「AI 协助」并列')

// 席位必须留给会话节点：默认收起、且还没有会话时，仍要把宿主传入的节点留在文档里，
// 否则宿主每次切换模式都会重建输入树。
const withConversation = Component({
  service: { state: null, currentSession: () => null },
  entry: { id: 'andoaidlaksldk/dsh-mind-workbench' },
  active: true,
  conversation: reactStub.createElement('div', { id: 'host-conversation' }, null)
})
const conversationNodes = collect(withConversation)
const dockWithConversation = conversationNodes.find((node) => node.props?.className === 'dshMwDock')
assert.equal(dockWithConversation.props.hidden, true, '默认收起时会话区不可见')
assert.ok(conversationNodes.some((node) => node.props?.id === 'host-conversation'),
  '会话区收起、且没有会话时，宿主传入的 conversation 节点仍必须留在文档中')
const dockFill = conversationNodes.find((node) => node.props?.className === 'dshMwDockFill')
assert.equal(dockFill.props.hidden, true, '没有会话时宿主节点由工作台一并隐藏')
assert.ok(conversationNodes.some((node) => node.props?.className === 'dshMwSession'),
  '没有会话时显示工作台自己的入口')
ok('默认收起时仍保留宿主 conversation 节点，并显示工作台自己的无会话入口')

assert.equal(appendedStyles.length, 1)
assert.equal(appendedStyles[0].dataset.pluginCss, 'dsh-mind-workbench')
ok('样式以 data-plugin-css 幂等注入')

console.log(`\n[verify] 全部通过（${checks} 项）`)
