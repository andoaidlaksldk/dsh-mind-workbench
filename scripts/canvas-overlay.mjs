/**
 * 把「画布定制」（overlay）应用到上游思维导图源码，并可选重新构建。
 *
 * 为什么要这一步：画布自带的「AI 配置」弹窗是 Vue 组件，要把它改成
 * 「供应商下拉框 + API Key + 模型 URL」，只能改源码重新构建，字符串替换做不到。
 * 改动的**权威副本**放在本包的 overlay/ 目录，上游仓库只是构建输入。
 *
 * 用法：
 *   node scripts/canvas-overlay.mjs             # 只应用源码改动
 *   node scripts/canvas-overlay.mjs --build     # 应用后执行上游构建（vue-cli-service build）
 *   node scripts/canvas-overlay.mjs --source "D:\path\to\mind-map-0.20.0"
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const sourceIndex = args.indexOf('--source')
const upstream = sourceIndex !== -1 && args[sourceIndex + 1]
  ? resolve(args[sourceIndex + 1])
  : resolve(ROOT, '..', 'mind-map-0.20.0')
const webRoot = join(upstream, 'web')
const dialogPath = join(webRoot, 'src', 'pages', 'Edit', 'components', 'AiConfigDialog.vue')
const langRoot = join(webRoot, 'src', 'lang')

if (!existsSync(dialogPath)) {
  console.error(`[overlay] 找不到上游源码：${dialogPath}（可用 --source 指定仓库根目录）`)
  process.exit(1)
}

// ---- 1. 弹窗组件：整体替换 ---------------------------------------------------
copyFileSync(join(ROOT, 'overlay', 'AiConfigDialog.vue'), dialogPath)
console.log('[overlay] 已替换 AiConfigDialog.vue（供应商下拉框 + API Key + 模型 URL）')

// ---- 2. 语言包：改文案 + 补新键 ---------------------------------------------
const LANGS = {
  'zh_cn.js': {
    values: {
      AIConfiguration: 'AI 模型配置',
      VolcanoArkLargeModelConfiguration: '模型供应商配置：',
      configTip: '先选供应商，再填 API Key 与模型 URL；也可以在 DSH 工作台面板的「模型配置」里统一设置。详细步骤见：',
      inferenceAccessPoint: '模型名',
      apiValidateTip: '请输入模型 URL',
      modelValidateTip: '请输入模型名'
    },
    add: { provider: '供应商', modelUrl: '模型 URL' }
  },
  'zh_tw.js': {
    values: {
      AIConfiguration: 'AI 模型設定',
      VolcanoArkLargeModelConfiguration: '模型供應商設定：',
      configTip: '先選供應商，再填 API Key 與模型 URL；也可以在 DSH 工作台面板的「模型配置」裡統一設定。詳細步驟見：',
      inferenceAccessPoint: '模型名',
      apiValidateTip: '請輸入模型 URL',
      modelValidateTip: '請輸入模型名'
    },
    add: { provider: '供應商', modelUrl: '模型 URL' }
  },
  'en_us.js': {
    values: {
      AIConfiguration: 'AI model settings',
      VolcanoArkLargeModelConfiguration: 'Model provider:',
      configTip: 'Pick a provider, then enter the API key and the model URL. You can also set it once in the DSH workbench panel. Steps: ',
      inferenceAccessPoint: 'Model name',
      apiValidateTip: 'Please enter the model URL',
      modelValidateTip: 'Please enter the model name'
    },
    add: { provider: 'Provider', modelUrl: 'Model URL' }
  },
  'vi_vn.js': {
    values: {
      AIConfiguration: 'Cấu hình mô hình AI',
      VolcanoArkLargeModelConfiguration: 'Nhà cung cấp mô hình:',
      configTip: 'Chọn nhà cung cấp, sau đó nhập API Key và URL mô hình. Cũng có thể cấu hình trong bảng DSH. Xem hướng dẫn: ',
      inferenceAccessPoint: 'Tên mô hình',
      apiValidateTip: 'Vui lòng nhập URL mô hình',
      modelValidateTip: 'Vui lòng nhập tên mô hình'
    },
    add: { provider: 'Nhà cung cấp', modelUrl: 'URL mô hình' }
  }
}

for (const [file, spec] of Object.entries(LANGS)) {
  const absolute = join(langRoot, file)
  if (!existsSync(absolute)) {
    console.warn(`[overlay] 跳过缺失的语言包 ${file}`)
    continue
  }
  let text = readFileSync(absolute, 'utf8')
  // 自愈：早期版本插入新键时会把原来的尾逗号留在后面，形成 `,,`（JS 语法错误）。
  text = text.replace(/,,(\s*\n)/g, ',$1')
  let changed = 0
  for (const [key, value] of Object.entries(spec.values)) {
    // 必须锚定行首，否则 AIConfiguration 会命中 modifyAIConfiguration、configTip 会命中 wantModifyAiConfigTip
    const pattern = new RegExp(`^(\\s*)${key}:\\s*'[^']*'`, 'm')
    if (!pattern.test(text)) {
      console.warn(`[overlay] ${file} 缺少键 ${key}，跳过`)
      continue
    }
    text = text.replace(pattern, `$1${key}: '${value.replace(/'/g, "\\'")}'`)
    changed += 1
  }
  // 把新键插在 course 之后。模式里连可选的尾逗号一起吃掉，再统一补上，
  // 否则原来的尾逗号会残留到新增的最后一行后面（`,,` → 语法错误）。
  const coursePattern = /^(\s*)course:\s*'([^']*)',?/m
  const courseMatch = coursePattern.exec(text)
  if (courseMatch && !new RegExp(`^\\s*provider:`, 'm').test(text)) {
    const indent = courseMatch[1]
    const additions = Object.entries(spec.add)
      .map(([key, value]) => `${indent}${key}: '${value}',`)
      .join('\n')
    text = text.replace(coursePattern, `${indent}course: '${courseMatch[2]}',\n${additions}`)
    changed += 1
  }
  writeFileSync(absolute, text, 'utf8')
  console.log(`[overlay] 已更新 ${file}（${changed} 处）`)
}

// ---- 3. 本地桥地址：源码层直接改成同源路径 -----------------------------------
// 上游画布把 AI 请求发给闭源客户端的本地服务（localhost:3456）。本工作台自己实现了
// 这个桥，所以源码里就改成同源路径，避免再依赖构建产物层的字符串替换。
const BRIDGE_REWRITES = [
  {
    file: join(webRoot, 'src', 'utils', 'ai.js'),
    from: '`http://localhost:${this.options.port}/ai/chat`',
    to: "'/api/dsh-mind-workbench/ai/chat'"
  },
  {
    file: join(webRoot, 'src', 'pages', 'Edit', 'components', 'AiCreate.vue'),
    from: '`http://localhost:${this.aiConfig.port}/ai/test`',
    to: "'/api/dsh-mind-workbench/ai/test'"
  }
]

for (const rewrite of BRIDGE_REWRITES) {
  if (!existsSync(rewrite.file)) {
    console.warn(`[overlay] 跳过缺失文件 ${rewrite.file}`)
    continue
  }
  const text = readFileSync(rewrite.file, 'utf8')
  if (!text.includes(rewrite.from)) {
    if (text.includes(rewrite.to)) console.log(`[overlay] ${rewrite.file.replace(webRoot, '…')} 已是同源地址，跳过`)
    else console.warn(`[overlay] ${rewrite.file.replace(webRoot, '…')} 找不到待替换的本地桥地址，请检查上游是否改版`)
    continue
  }
  const count = text.split(rewrite.from).length - 1
  writeFileSync(rewrite.file, text.split(rewrite.from).join(rewrite.to), 'utf8')
  console.log(`[overlay] 已把 ${rewrite.file.replace(webRoot, '…')} 里 ${count} 处本地桥地址改为同源路径`)
}

// ---- 3.5 画布源码补丁：菜单、全屏 API ----------------------------------------
// 与语言包同样的做法：逐条精确替换，找不到就告警（上游改版时能立刻发现）。
const workbenchVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const LIBRARY_UTILS = join(upstream, 'simple-mind-map', 'src', 'utils', 'index.js')
const WEB_UTILS = join(webRoot, 'src', 'utils', 'index.js')
const NAVIGATOR = join(webRoot, 'src', 'pages', 'Edit', 'components', 'NavigatorToolbar.vue')

const FULLSCREEN_REQUEST = `export const fullScreen = element => {
  if (element.requestFullScreen) {
    element.requestFullScreen()
  } else if (element.webkitRequestFullScreen) {
    element.webkitRequestFullScreen()
  } else if (element.mozRequestFullScreen) {
    element.mozRequestFullScreen()
  }
}`

const FULLSCREEN_REQUEST_FIXED = `export const fullScreen = element => {
  // 原实现只认带大写 S 的旧名字（requestFullScreen / webkitRequestFullScreen），
  // 而这个 API 的标准名是 requestFullscreen：在 Chromium 里前者不存在时整个函数
  // 静默什么都不做，表现就是「点演示模式没有反应」。这里标准名优先，并且把失败
  // 显式打出来，避免再次出现"点了没动静也看不到原因"。
  const request =
    element.requestFullscreen ||
    element.webkitRequestFullscreen ||
    element.webkitRequestFullScreen ||
    element.mozRequestFullScreen ||
    element.msRequestFullscreen
  if (!request) {
    console.error('[mind-map] 当前环境不支持全屏 API')
    return
  }
  try {
    const result = request.call(element)
    if (result && typeof result.catch === 'function') {
      result.catch(error => {
        console.error('[mind-map] 进入全屏被拒绝：', error)
      })
    }
  } catch (error) {
    console.error('[mind-map] 进入全屏失败：', error)
  }
}`

const SOURCE_PATCHES = [
  {
    // 「更多」菜单：去掉「下载客户端」「官方网站」，Github 指向本工作台仓库，
    // 版本号改为本工作台的版本（由上面的 workbenchVersion 注入）。
    file: NAVIGATOR,
    patches: [
      {
        label: '移除「下载客户端」菜单项',
        from: `          <el-dropdown-item command="client">
            <span class="iconfont iconxiazai"></span>
            {{ $t('navigatorToolbar.downloadClient') }}
          </el-dropdown-item>
`,
        to: ''
      },
      {
        label: '移除「官方网站」菜单项',
        from: `          <el-dropdown-item command="site">
            <span class="iconfont iconwangzhan"></span>
            {{ $t('navigatorToolbar.site') }}
          </el-dropdown-item>
`,
        to: ''
      },
      {
        label: 'Github 指向本工作台仓库',
        from: "          url = 'https://github.com/wanglin2/mind-map'",
        to: "          url = 'https://github.com/andoaidlaksldk/dsh-mind-workbench'"
      },
      {
        label: '版本号不再取自上游依赖',
        from: "import pkg from 'simple-mind-map/package.json'",
        to: '// 版本号由构建时注入（scripts/canvas-overlay.mjs）'
      },
      {
        label: '版本号改为构建时注入（源码里只留占位符）',
        from: '      version: pkg.version,',
        to: "      version: '__WORKBENCH_VERSION__',"
      }
    ]
  },
  {
    // 全屏：库与 web 各有一份同样的错误实现，都要修。
    file: LIBRARY_UTILS,
    patches: [
      { label: '全屏 API 用标准名（库）', from: FULLSCREEN_REQUEST, to: FULLSCREEN_REQUEST_FIXED },
      {
        label: '全屏事件检测用标准名（库）',
        from: '  if (document.documentElement.requestFullScreen) {',
        to: '  if (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullScreen) {'
      }
    ]
  },
  {
    file: WEB_UTILS,
    patches: [
      { label: '全屏 API 用标准名（web）', from: FULLSCREEN_REQUEST, to: FULLSCREEN_REQUEST_FIXED },
      {
        label: '全屏事件检测用标准名（web）',
        from: '  if (document.documentElement.requestFullScreen) {',
        to: '  if (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullScreen) {'
      }
    ]
  }
]

for (const target of SOURCE_PATCHES) {
  if (!existsSync(target.file)) {
    console.warn(`[overlay] 跳过缺失文件 ${target.file}`)
    continue
  }
  let text = readFileSync(target.file, 'utf8')
  const relative = target.file.slice(upstream.length)
  let applied = 0
  for (const patch of target.patches) {
    if (!text.includes(patch.from)) {
      // 这条多半是上次已经应用过了（脚本是幂等的）。真正的上游改版也会走到这里，
      // 所以只提示、不当错误。删除类补丁本来就是"找不到才算完成"。
      console.log(`[overlay] ${relative}：${patch.label} —— 无需处理（已应用或上游已改）`)
      continue
    }
    text = text.split(patch.from).join(patch.to)
    applied += 1
    console.log(`[overlay] ${relative}：${patch.label}`)
  }
  if (applied === 0 && target.patches.every((patch) => patch.to !== '')) {
    // 非删除类补丁一条都没命中，值得提醒一次。
    console.log(`[overlay] ${relative}：全部 ${target.patches.length} 条补丁都已处于目标状态`)
  }
  writeFileSync(target.file, text, 'utf8')
}

// 版本号归一化：无论源文件里当前是 `pkg.version`、还是上一轮注入过的具体版本，
// 一律改成占位符，再由 sync-app 在产物里替换成本包当前版本。
// 这样升级版本号不需要改源码，也不会留下过期版本字符串。
if (existsSync(NAVIGATOR)) {
  const before = readFileSync(NAVIGATOR, 'utf8')
  const after = before.replace(/^(\s*version: )'[^']*',$/m, "$1'__WORKBENCH_VERSION__',")
  if (after !== before) {
    writeFileSync(NAVIGATOR, after, 'utf8')
    console.log('[overlay] NavigatorToolbar.vue：版本号已归一化为占位符（构建后由 sync-app 注入当前版本）')
  }
}

// ---- 4. 可选：重新构建 -------------------------------------------------------
if (args.includes('--build')) {
  console.log('[overlay] 开始构建上游画布（vue-cli-service build），可能需要 1-3 分钟…')
  // 上游用的是 webpack 4，在 Node 17+ 上会因为 OpenSSL 3 禁用 md4 而报
  // `error:0308010C:digital envelope routines::unsupported`，必须开 legacy provider。
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: webRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_OPTIONS: '--openssl-legacy-provider' }
  })
  if (result.status !== 0) {
    console.error(`[overlay] 构建失败（退出码 ${result.status}），未生成新的产物`)
    process.exit(1)
  }
  console.log('[overlay] 构建完成，接下来运行 node scripts/sync-app.mjs 把产物同步进 app/')
} else {
  console.log('[overlay] 源码改动已应用。加 --build 可顺带重新构建。')
}
