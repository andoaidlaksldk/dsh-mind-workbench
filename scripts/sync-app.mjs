#!/usr/bin/env node
/**
 * 从上游 mind-map 项目的已构建产物生成工作台内嵌应用目录 `app/`。
 *
 * 输入：<repo>/../mind-map-0.20.0/index.html 与 <repo>/../mind-map-0.20.0/dist
 * 输出：<repo>/app/index.html（改造后的宿主页）与 <repo>/app/dist（原样拷贝）
 *
 * 改造点只有三处，不触碰任何业务代码：
 *   1. 打开 `window.takeOverApp`，让应用把状态读写交给 `app/bridge.js`；
 *   2. 去掉第三方统计脚本（本地/离线使用不需要联网上报）；
 *   3. 用 `app/bridge.js` 取代上游 index.html 里的示例接管代码。
 *
 * 用法：node scripts/sync-app.mjs [--source <mind-map 目录>]
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceFlagIndex = process.argv.indexOf('--source')
const source = resolve(
  sourceFlagIndex !== -1 && process.argv[sourceFlagIndex + 1]
    ? process.argv[sourceFlagIndex + 1]
    : join(root, '..', 'mind-map-0.20.0')
)

// 本包当前版本：用于把画布「更多」菜单里的版本号占位符替换成真实版本。
const workbenchVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

const sourceHtmlPath = join(source, 'index.html')
const sourceDist = join(source, 'dist')
const targetHtmlPath = join(root, 'app', 'index.html')
const targetDist = join(root, 'app', 'dist')

function fail(message) {
  console.error(`[sync-app] ${message}`)
  process.exit(1)
}

if (!existsSync(sourceHtmlPath)) fail(`找不到上游入口页：${sourceHtmlPath}`)
if (!existsSync(sourceDist)) fail(`找不到上游构建产物：${sourceDist}`)

const sourceHtml = readFileSync(sourceHtmlPath, 'utf8')

// 构建产物里的样式表与脚本标签带构建期 hash，必须原样保留。
const stylesheetTags = sourceHtml.match(/<link[^>]+rel="stylesheet"[^>]*>/g) || []
const scriptTags = sourceHtml.match(/<script[^>]+src="dist\/[^"]+"[^>]*>\s*<\/script>/g) || []

if (!scriptTags.length) fail('上游入口页里没有找到 dist/ 下的脚本标签，无法生成宿主页。')

const html = `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta
      name="viewport"
      content="width=device-width,user-scalable=no,initial-scale=1.0,maximum-scale=1.0,minimum-scale=1.0"
    />
    <link rel="icon" href="dist/logo.ico" />
    <title>DSH 思维导图</title>
    <script>
      // 交给 DSH 工作台接管状态读写（见同目录 bridge.js）。
      window.takeOverApp = true
      window.dshMindWorkbenchHost = true
      // 自定义静态资源路径：相对于本页地址，即
      // /api/dsh-mind-workbench/app/ ，因此运行时按需加载的分块也落在同一前缀下。
      window.externalPublicPath = './dist/'
    </script>
${stylesheetTags.map((tag) => `    ${tag}`).join('\n')}
  </head>
  <body>
    <noscript>
      <strong>画布需要启用 JavaScript 才能运行。</strong>
    </noscript>
    <div id="app"></div>
    <!-- 接管桥必须在应用脚本之前定义 window.onload -->
    <script src="bridge.js"></script>
${scriptTags.map((tag) => `    ${tag}`).join('\n')}
  </body>
</html>
`

mkdirSync(join(root, 'app'), { recursive: true })
rmSync(targetDist, { recursive: true, force: true })
cpSync(sourceDist, targetDist, { recursive: true })
writeFileSync(targetHtmlPath, html, 'utf8')

// --- 文件名 ASCII 化 ---------------------------------------------------------
// Harness 的精确 fetch 路由要求路径每一段匹配 `/^[A-Za-z0-9_$.-]+$/`；
// 上游产物里有非 ASCII 文件名（如 `图片加载失败.svg`），直接登记会被判为
// `invalid exact Fetch route`。这里把违规文件名改成等价 ASCII 名，
// 并在全部文本产物里同步改写引用，保证应用自身仍然能找到它。
const SEGMENT_OK = /^[A-Za-z0-9_$.-]+$/
const TEXT_EXTENSIONS = new Set(['.js', '.css', '.html', '.json', '.svg', '.mjs', '.txt'])
const renames = []

function sanitizeFileName(name) {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  const cleaned = base.replace(/[^A-Za-z0-9_$.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return `${cleaned || 'asset'}${extension}`
}

function walkTarget(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      walkTarget(absolute, relative)
      continue
    }
    if (SEGMENT_OK.test(entry.name)) continue
    const extension = extname(entry.name)
    const stem = entry.name.slice(0, entry.name.length - extension.length)
    let next = sanitizeFileName(entry.name)
    let suffix = 2
    while (existsSync(join(directory, next))) next = `${sanitizeFileName(stem)}-${suffix++}${extension}`
    renameSync(absolute, join(directory, next))
    renames.push({ directory, from: entry.name, to: next, relative })
    console.log(`[sync-app] 重命名非法文件名：${relative} → ${next}`)
  }
}

function rewriteReferences(oldName, newName) {
  let touched = 0
  const stack = [join(root, 'app')]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(absolute)
        continue
      }
      if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      const text = readFileSync(absolute, 'utf8')
      if (!text.includes(oldName)) continue
      writeFileSync(absolute, text.split(oldName).join(newName), 'utf8')
      touched += 1
    }
  }
  return touched
}

walkTarget(targetDist)
for (const { from, to, relative } of renames) {
  const touched = rewriteReferences(from, to)
  if (touched === 0) console.warn(`[sync-app] 提示：${relative} 改名后没有找到引用它的文本文件，可能是未使用的素材`)
  else console.log(`[sync-app] 已改写 ${touched} 个文件中对 ${from} 的引用`)
}
if (!renames.length) console.log('[sync-app] 所有产物文件名均符合路由段要求，无需改名')

// --- 模型配置教程：生成页面 + 改写弹窗里的「教程」链接 -------------------------
// 上游 AiConfigDialog.vue 把「教程」写死指向一篇微信公众号文章。这里改成指向本包
// 自己托管的教程页（docs/ai-model-setup.md 渲染而来），离线可用、不依赖外部站点。
// 想改用别的地址（例如发布到 GitHub 后的 raw 链接）时传 --tutorial-url 即可。
const UPSTREAM_TUTORIAL_URL = 'https://mp.weixin.qq.com/s/JNb7PH4sCjWzIZ9G8wStGQ'
const TUTORIAL_MARKDOWN = join(root, 'docs', 'ai-model-setup.md')
const TUTORIAL_PAGE = 'docs/ai-model-setup.html'
const tutorialFlagIndex = process.argv.indexOf('--tutorial-url')
const tutorialUrl = tutorialFlagIndex !== -1 && process.argv[tutorialFlagIndex + 1]
  ? process.argv[tutorialFlagIndex + 1]
  : `/api/dsh-mind-workbench/app/${TUTORIAL_PAGE}`

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
}

/** 够用的 Markdown 渲染：标题/段落/列表/引用/代码块/表格/分隔线/行内标记。 */
function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let index = 0

  const listItem = (line) => {
    const ordered = /^\d+\.\s+/.exec(line)
    if (ordered) return { type: 'ol', text: line.slice(ordered[0].length) }
    const bullet = /^[-*]\s+/.exec(line)
    if (bullet) return { type: 'ul', text: line.slice(bullet[0].length) }
    return null
  }

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) {
      index += 1
      continue
    }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim()
      const body = []
      index += 1
      while (index < lines.length && !lines[index].startsWith('```')) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      out.push(`<pre><code${language ? ` data-lang="${escapeHtml(language)}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      index += 1
      continue
    }

    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      out.push('<hr />')
      index += 1
      continue
    }

    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[index + 1] || '')) {
      const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
      const header = cells(line)
      index += 2
      const rows = []
      while (index < lines.length && lines[index].startsWith('|')) {
        rows.push(cells(lines[index]))
        index += 1
      }
      out.push(`<table><thead><tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }

    if (line.startsWith('>')) {
      const quote = []
      while (index < lines.length && lines[index].startsWith('>')) {
        quote.push(lines[index].replace(/^>\s?/, ''))
        index += 1
      }
      out.push(`<blockquote>${quote.map((text) => (text.trim() ? `<p>${renderInline(text)}</p>` : '')).join('')}</blockquote>`)
      continue
    }

    const item = listItem(line)
    if (item) {
      const items = []
      while (index < lines.length) {
        const current = listItem(lines[index])
        if (!current || current.type !== item.type) break
        items.push(current.text)
        index += 1
      }
      out.push(`<${item.type}>${items.map((text) => `<li>${renderInline(text)}</li>`).join('')}</${item.type}>`)
      continue
    }

    const paragraph = [line]
    index += 1
    while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s|```|>|\||[-*]\s|\d+\.\s)/.test(lines[index])) {
      paragraph.push(lines[index])
      index += 1
    }
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`)
  }
  return out.join('\n')
}

function buildTutorialPage(url) {
  if (!existsSync(TUTORIAL_MARKDOWN)) {
    console.warn(`[sync-app] 警告：找不到教程源文件 ${TUTORIAL_MARKDOWN}，跳过教程页生成`)
    return false
  }
  const markdown = readFileSync(TUTORIAL_MARKDOWN, 'utf8')
  const title = (/^#\s+(.*)$/m.exec(markdown) || [, '模型配置教程'])[1]
  const html = `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <!-- 由 scripts/sync-app.mjs 从 docs/ai-model-setup.md 生成，请勿直接编辑 -->
    <style>
      :root{color-scheme:light dark}
      body{margin:0;padding:32px 24px 64px;background:#f7f8fa;color:#1f2329;
        font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
      main{max-width:760px;margin:0 auto;background:#fff;border:1px solid #e5e6eb;border-radius:12px;
        padding:28px 32px 40px;box-shadow:0 2px 12px rgba(0,0,0,.04)}
      h1{font-size:24px;line-height:1.4;margin:0 0 20px}
      h2{font-size:18px;margin:32px 0 12px;padding-top:16px;border-top:1px solid #f0f0f0}
      h2:first-of-type{border-top:0;padding-top:0}
      h3{font-size:16px;margin:24px 0 10px}
      p{margin:10px 0}
      a{color:#2454ff;word-break:break-all}
      code{background:#f2f3f5;border-radius:4px;padding:1px 5px;font-size:13px;
        font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
      pre{background:#f7f8fa;border:1px solid #e5e6eb;border-radius:8px;padding:12px 14px;overflow:auto}
      pre code{background:none;padding:0}
      ul,ol{margin:10px 0;padding-left:22px}
      li{margin:4px 0}
      blockquote{margin:14px 0;padding:10px 14px;background:#f7f8fa;border-left:3px solid #2454ff;border-radius:0 8px 8px 0}
      blockquote p{margin:4px 0}
      table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px}
      th,td{border:1px solid #e5e6eb;padding:8px 10px;text-align:left;vertical-align:top}
      th{background:#f7f8fa;font-weight:600}
      hr{border:0;border-top:1px solid #f0f0f0;margin:24px 0}
      @media (prefers-color-scheme:dark){
        body{background:#17181a;color:#e8e8e8}
        main{background:#1f2022;border-color:#2f3033;box-shadow:none}
        h2{border-color:#2f3033}
        code,pre,blockquote{background:#26272a}
        pre,table th,table td{border-color:#333438}
        th{background:#26272a}
      }
    </style>
  </head>
  <body>
    <main>
${renderMarkdown(markdown)}
    </main>
  </body>
</html>
`
  const target = join(root, 'app', TUTORIAL_PAGE)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, html, 'utf8')
  console.log(`[sync-app] 已生成教程页 app/${TUTORIAL_PAGE}（来自 docs/ai-model-setup.md，链接指向 ${url}）`)
  return true
}

function rewriteTutorialLinks(url) {
  let touched = 0
  const stack = [join(root, 'app')]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(absolute)
        continue
      }
      if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      const text = readFileSync(absolute, 'utf8')
      if (!text.includes(UPSTREAM_TUTORIAL_URL)) continue
      writeFileSync(absolute, text.split(UPSTREAM_TUTORIAL_URL).join(url), 'utf8')
      touched += 1
    }
  }
  return touched
}

buildTutorialPage(tutorialUrl)
const tutorialTouched = rewriteTutorialLinks(tutorialUrl)
if (tutorialTouched === 0) {
  console.warn('[sync-app] 警告：没有找到上游的教程链接，AI 配置弹窗里可能仍是旧地址')
} else {
  console.log(`[sync-app] 已把 ${tutorialTouched} 个产物里的「教程」链接改为 ${tutorialUrl}`)
}

// --- AI 请求改走本插件的本地桥 -----------------------------------------------
// 上游画布把 AI 请求 POST 给「本地桥」（闭源客户端，默认 http://localhost:3456/ai/chat），
// 由它转发到火山方舟。这里把这个地址换成同源路径，由本插件服务端实现桥：
// 于是无需任何闭源客户端，并且可以按用户选择的供应商转发（多供应商支持）。
const UPSTREAM_AI_BRIDGE = '`http://localhost:${this.options.port}/ai/chat`'
const AI_BRIDGE_URL = "'/api/dsh-mind-workbench/ai/chat'"

function rewriteAiBridge() {
  let touched = 0
  const stack = [join(root, 'app')]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(absolute)
        continue
      }
      if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      const text = readFileSync(absolute, 'utf8')
      if (!text.includes(UPSTREAM_AI_BRIDGE)) continue
      writeFileSync(absolute, text.split(UPSTREAM_AI_BRIDGE).join(AI_BRIDGE_URL), 'utf8')
      touched += 1
    }
  }
  return touched
}

const aiTouched = rewriteAiBridge()
if (aiTouched === 0) {
  // 正常路径：scripts/canvas-overlay.mjs 已在源码层把桥地址改成同源，产物层无需再改。
  console.log('[sync-app] AI 桥地址已在源码层改写（scripts/canvas-overlay.mjs），产物层无需处理')
} else {
  console.log(`[sync-app] 已把 ${aiTouched} 个产物里的 AI 请求地址改为同源 ${AI_BRIDGE_URL.slice(1, -1)}`)
}

// --- 画布自带「AI 配置」弹窗的文案 --------------------------------------------
// 上游弹窗写死「目前仅支持火山方舟大模型…」，但本工作台已经把 AI 请求改走自己的桥，
// 支持多家供应商（面板右上角「模型配置」）。文案不改，用户就会以为这功能还是老样子
// （而且这句话本身已经不成立了），所以这里如实改写。
const DIALOG_COPY = [
  [
    '火山方舟大模型配置：',
    'AI 模型配置（火山方舟）：'
  ],
  [
    '目前仅支持火山方舟大模型，需要自行去获取key，详细操作步骤见：',
    '本工作台支持多家供应商（DeepSeek / OpenAI / 通义 / 智谱 / Ollama 等）：推荐用面板右上角「模型配置」统一配置；只填火山方舟的 Key 与推理接入点也可直接用。详细步骤见：'
  ],
  [
    '目前僅支持火山方舟大模型，需要自行去獲取key，詳細操作步驟見：',
    '本工作台支援多家供應商（DeepSeek / OpenAI / 通義 / 智譜 / Ollama 等）：建議用面板右上角「模型配置」統一設定；只填火山方舟的 Key 與推理接入點也可直接用。詳細步驟見：'
  ]
]

function rewriteDialogCopy() {
  let touched = 0
  const missing = []
  const stack = [join(root, 'app')]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(absolute)
        continue
      }
      const dot = entry.name.lastIndexOf('.')
      if (dot <= 0 || !TEXT_EXTENSIONS.has(entry.name.slice(dot))) continue
      let text = readFileSync(absolute, 'utf8')
      let changed = false
      for (const [from, to] of DIALOG_COPY) {
        if (!text.includes(from)) continue
        text = text.split(from).join(to)
        changed = true
      }
      if (changed) {
        writeFileSync(absolute, text, 'utf8')
        touched += 1
      }
    }
  }
  return { touched, missing }
}

const dialogCopy = rewriteDialogCopy()
if (dialogCopy.touched === 0) {
  // 正常路径：scripts/canvas-overlay.mjs 已在源码层改写了弹窗文案。
  console.log('[sync-app] AI 配置弹窗文案已在源码层改写（scripts/canvas-overlay.mjs），产物层无需处理')
} else {
  console.log(`[sync-app] 已改写 ${dialogCopy.touched} 个产物里的 AI 配置弹窗文案（改为多供应商说明）`)
}

// --- 品牌清理：产物里不得出现上游项目的名称与链接 -----------------------------
// 内嵌画布是第三方构建产物，它的 i18n、示例数据、"更多/关于"菜单与内嵌依赖元数据里
// 带着上游项目名、站点与 GitHub 链接。本包对外只呈现自己的工作台身份，所以在这里清掉。
// 链接类一并改指宿主产品站点，因此"更多/关于"菜单仍然可用。
//
// ⚠ 硬约束（踩过一次，代价是整块画布白屏）：**只允许替换字符串字面量**。
// 同一个词在产物里还以**真实标识符**出现，例如
//     xe = e => ({ simpleMindMap: !0, data: e })      对象字面量的键
//     "object" === typeof n && n.simpleMindMap         属性访问
// 把它们换成带连字符的写法会直接产生 `SyntaxError: Unexpected token '-'`，
// 结果就是画布白屏 + `window.initApp` 未定义。
// 所以这里**没有任何"宽泛变体"规则**：每条都锚定引号或明确的字符串上下文，
// 而 `simpleMindMap` 这个内部标识符保持原样（它是代码，不是对外内容）。
const BRAND_SCRUB = [
  // 链接：长的先替换，避免被短模式截断。
  [/https:\/\/wanglin2\.github\.io\/mind-map-docs\/[^"'\\)\s]*/g, 'https://dshdesktop.com/'],
  [/https:\/\/github\.com\/wanglin2\/mind-map[^"'\\)\s]*/g, 'https://dshdesktop.com/'],
  [/https:\/\/sxmind\.cn\/?/g, 'https://dshdesktop.com/'],
  [/https:\/\/pan\.baidu\.com\/[^"'\\)\s]*/g, 'https://dshdesktop.com/'],
  // 导出设置里「底部文字」的占位符（四种语言各一处）
  [/比如：来自\s*simple-mind-map/g, '比如：来自本工作台'],
  [/例如：來自\s*simple-mind-map/g, '例如：來自本工作台'],
  [/For example: From\s*simple-mind-map/g, 'For example: From this workbench'],
  [/Ví dụ: Từ\s*simple-mind-map/g, 'Ví dụ: Từ bảng này'],
  // 导出格式的名称与说明（四种语言；锚定 name:" / desc:"，不可能命中标识符）
  [/name:"思绪文件"/g, 'name:"导图文件"'],
  [/name:"思绪 file"/g, 'name:"mind-map file"'],
  [/name:"思緒檔案"/g, 'name:"導圖檔案"'],
  [/name:"思绪Tài liệu"/g, 'name:"mind-map 文件"'],
  [/desc:"SimpleMindMap/g, 'desc:"mind-map'],
  // 内嵌依赖的元数据与自家存储键名（都在字符串里）
  [/"name":"simple-mind-map"/g, '"name":"mind-map-workbench"'],
  [/dist\/simpleMindMap\.umd\.min\.js/g, 'dist/mindMapWorkbench.umd.min.js'],
  [/"simpleMindMap_"/g, '"mindMapWorkbench_"'],
  [/SIMPLE_MIND_MAP_LOCAL_CONFIG/g, 'MIND_MAP_WORKBENCH_LOCAL_CONFIG'],
  [/SIMPLE_MIND_MAP_DATA/g, 'MIND_MAP_WORKBENCH_DATA'],
  [/SIMPLE_MIND_MAP_CONFIG/g, 'MIND_MAP_WORKBENCH_CONFIG'],
  [/SIMPLE_MIND_MAP_LANG/g, 'MIND_MAP_WORKBENCH_LANG'],
  // 中文品牌词与裸站点名兜底（此时 URL 已换完，剩下的只可能是文案）
  [/思绪思维导图/g, '思维导图'],
  [/sxmind/gi, 'dshdesktop'],
  // 「更多」菜单里的版本号：源码只留占位符，这里注入本包当前版本，
  // 因此升级版本号只需改 package.json，不必重新打补丁或改源码。
  // 注意压缩后引号会被规整成双引号，所以两种引号都要匹配。
  [/'__WORKBENCH_VERSION__'/g, `'${workbenchVersion}'`],
  [/"__WORKBENCH_VERSION__"/g, `"${workbenchVersion}"`]
]

function scrubBrand() {
  let touched = 0
  const stack = [join(root, 'app')]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(absolute)
        continue
      }
      const dot = entry.name.lastIndexOf('.')
      if (dot <= 0 || !TEXT_EXTENSIONS.has(entry.name.slice(dot))) continue
      const before = readFileSync(absolute, 'utf8')
      let after = before
      for (const [pattern, replacement] of BRAND_SCRUB) after = after.replace(pattern, replacement)
      if (after !== before) {
        writeFileSync(absolute, after, 'utf8')
        touched += 1
      }
    }
  }
  return touched
}

console.log(`[sync-app] 已清理 ${scrubBrand()} 个产物文件里的上游品牌与链接`)

// --- 语法闸门 -----------------------------------------------------------------
// 文本级改写一旦误伤标识符，产物会变成语法错误，外在表现是整块画布白屏
// （`window.initApp` 未定义 + 面板转成"离线"）。这里对每个 JS 产物做真实语法检查，
// 不通过就直接中断构建——宁可这次没有新产物，也不要交付一个打不开的画布。
function assertJavaScriptParses() {
  const targets = []
  const stack = [join(root, 'app')]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) stack.push(absolute)
      else if (entry.name.endsWith('.js')) targets.push(absolute)
    }
  }
  const failures = []
  for (const file of targets) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (result.status !== 0) {
      const detail = String(result.stderr || '').split('\n')
        .find((line) => line.includes('SyntaxError')) || '语法错误'
      failures.push(`${file.slice(root.length)}：${detail.trim()}`)
    }
  }
  if (failures.length) {
    console.error('[sync-app] 语法闸门未通过，已中断：')
    for (const line of failures) console.error(`    ${line}`)
    process.exit(1)
  }
  console.log(`[sync-app] 语法闸门通过（${targets.length} 个 JS 产物）`)
}

assertJavaScriptParses()

console.log(`[sync-app] 源目录：${source}`)
console.log(`[sync-app] 已生成 ${targetHtmlPath}（样式 ${stylesheetTags.length} 个，脚本 ${scriptTags.length} 个）`)
console.log(`[sync-app] 已拷贝 ${targetDist}`)
