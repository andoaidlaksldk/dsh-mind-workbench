# 集成方案：把 mind-map 思维导图嵌入 DSH Desktop 工作台

本文件说明 `DSHMindWorkbench`（新项目）如何把 `mind-map-0.20.0`（思维导图）的完整功能
集成为 `dsh-desktop-0.11.1` 的一个工作台模块，以及为此对 dsh-desktop 做的全部代码修改。

---

## 1. 结论先行

| 项目 | 取值 |
|---|---|
| 新项目 | 本目录（仓库根即包根），npm 包名 `dsh-mind-workbench`，显示名 `DSHMindWorkbench` |
| 形态 | 一个符合《工作台开发规范》的 DSH 插件包（npm 包 + Cordis bundle + Desktop 工作台） |
| 工作台身份 | `dataelement/dsh-mind-workbench`（由 `register({ repository })` 解析；上架前需改成真实仓库） |
| 数据目录 | `dshHomePath('mind-workbench')` → `%USERPROFILE%\.dsh\mind-workbench`（或当前 DSH_HOME） |
| 服务端路径前缀 | `/api/dsh-mind-workbench/` |
| 对 dsh-desktop 的改动 | 3 处新增，0 处修改既有逻辑（见第 6 节） |

**功能保留策略**：不重写、不改动上游任何业务代码，把上游已构建的 Web 应用（50 个 Vue 页面、
上百个主题、全部导入导出格式、画布与节点操作）原样托管，通过上游内建的「接管模式」
把数据存取接进 DSH。这样「完整保留所有核心功能」是可证伪的：功能清单等同于上游版本。

**遵循的规范版本**：官方《工作台开发规范》**2026-10-09**（`https://dshdesktop.com/workbench/docs/development.md`）。
注意 dsh-desktop 仓库内附的离线副本 `docs/workbench-standard.zh.md` 标注的是 2026-09-29，
**缺**第 4.1 节「先按主任务选择布局」与第 1 节「同机重启边界」。本工作台按 2026-10-09 版实现，
其中 4.1 直接决定了下面第 4 节的布局选择（业务整页 + 按需 AI 会话）。

---

## 2. 为什么不是「把 Vue 重写成 React 组件」

先看两边的真实技术形态：

- `mind-map-0.20.0`：内嵌画布应用（Vue 2.6 + ElementUI 2.15 + Vuex + Vue Router，
  50 个 `.vue` 页面，约 4.5 MB 构建产物）。
- `dsh-desktop-0.11.1`：工作台规范要求业务面板是一个 **React 组件**，
  通过 `ctx.desktopWorkbenches.register(descriptor, Component)` 注册；宿主
  `dsh-desktop-workbenches` 负责渲染、布局与错误隔离。

规范与仓库现状共同限定了可用手段：

| 手段 | 是否可用 | 依据 |
|---|---|---|
| `<webview>` | **不可用** | `src/main/security.ts:17` 显式 `will-attach-webview` → `preventDefault()` |
| 宿主加载你的 `dist/index.html` | **不支持** | 客户端是模块加载器协议（`window.__ModuleLoader__`），不是页面 URL |
| 宿主提供 iframe 容器 | 不提供 | 工作台只接收一个 React 组件 |
| 在自己的 React 面板内使用同源 iframe | 可用 | 渲染进程本身是同源 `http://127.0.0.1:<port>`；仓库内已有 iframe + postMessage 先例（`src/preload/index.ts` 的 Safe Mode 页） |
| 重写为 React | 可用但代价极高 | 需要重做 50 个页面 + ElementUI 依赖 + Vuex/Router，无法保证「完整保留」 |

因此选择：**React 面板 + 同源 iframe 承载上游构建产物 + 上游官方接管模式打通数据**。
面板本身是纯 React（工具栏、状态、对话框、会话停靠），只有画布是上游应用。

---

## 3. 三层集成模型

```
┌──────────────────────── dsh-desktop 渲染进程 (http://127.0.0.1:<port>) ───────────────────────┐
│  dsh-desktop-workbenches（宿主）                                                              │
│    └── customFrame 主内容区                                                                   │
│         └── lib/client.js 注册的 React 面板  <header>工具栏 ── 画布 iframe ── 会话停靠区      │
│                                                                                               │
│  ② 同源 iframe：/api/dsh-mind-workbench/app/index.html                                        │
│     └── app/bridge.js  ── 实现 window.takeOverAppMethods（上游接管契约，8 个方法）             │
│                          └── fetch 同源接口 → ③                                                │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                     │
┌──────────────── Harness 主进程 ────┼──────────────────────────────────────────────────────────┐
│  dsh/index.js（服务端入口，inject: ['connection']）                                            │
│    ① 静态托管：装载期枚举 app/ 逐文件注册精确路由（282 条，含非 ASCII 文件名）                  │
│    ③ 数据接口：/session、/session/data、/session/preferences、/documents、/health               │
│       └── 落盘到 config.root：state.json + documents/<id>.json（原子写：tmp + rename）         │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### ① 静态托管（`dsh/index.js`）

工作台的 fetch 路由按**精确路径**匹配（仓库内所有插件都是这么注册的），没有目录级通配。
因此服务端在插件装载期递归枚举 `app/`，为每个文件注册一条 `GET/HEAD` 路由，
按扩展名给出正确的 `content-type`；入口页 `no-store`，其余 `no-cache`。
`encodeURI()` 保证 `app/dist/img/图片加载失败.svg` 这类文件名也可访问。

`app/index.html` 里的 `window.externalPublicPath = './dist/'` 是**相对**路径，
因此 webpack 运行时按需加载的分块、字体、图片全部落在同一前缀下，无需改写任何资源引用。

### ② 数据接管（`app/bridge.js`）

上游 `web/src/api/index.js` 内建接管模式：只要 `window.takeOverApp === true` 且
`window.takeOverAppMethods` 实现了 8 个方法，应用的**全部状态**就交给宿主，不再用 localStorage：

| 方法 | 桥的实现 |
|---|---|
| `getMindMapData` / `saveMindMapData` | 内存持有整份导图数据；变更后 400 ms 防抖 → `POST /session/data` |
| `getMindMapConfig` / `saveMindMapConfig` | 实例化配置 → `POST /session/preferences` |
| `getLanguage` / `saveLanguage` | 语言 → `POST /session/preferences` |
| `getLocalConfig` / `saveLocalConfig` | 本地配置 → `POST /session/preferences` |

`index.html` 的 `<head>` 里在任何应用脚本之前置位 `window.takeOverApp = true`，
`bridge.js` 在 `window.onload` 里先 `await` 拉取数据、再调用 `window.initApp()`，
保证画布首次渲染拿到的就是 DSH 侧的数据。

面板 ↔ 画布之间的 `postMessage`（`channel: 'dsh-mind-workbench'`，双向校验 origin）只用于
宿主发起的一次性动作：

| 方向 | 消息 | 用途 |
|---|---|---|
| 画布 → 面板 | `ready` | 画布就绪（含 `documentId`、`offline`） |
| 画布 → 面板 | `saved` / `error` | 保存回执 / 保存或启动失败（`scope` 区分） |
| 画布 → 面板 | `snapshot` | 响应面板的快照请求（导出用） |
| 面板 → 画布 | `flush` | 立即落盘（「立即保存」、关闭窗口前） |
| 面板 → 画布 | `snapshot` | 请求当前画布数据 → 导出 JSON |
| 面板 → 画布 | `command` | 透传到 `$bus.emit('execCommand', ...)`，为后续扩展预留 |

### ③ 工作台注册（`lib/client.js`）

```js
ctx.desktopWorkbenches.register({
  title: 'DSH 思维导图', titleEn: 'DSH Mind Workbench',
  repository: 'https://github.com/dataelement/dsh-mind-workbench',
  customFrame: true,            // 占据主内容区，画布最大化
  category: '效率工具', ...
}, Panel)
```

`customFrame: true` 让思维导图拿到整个主内容区（约 1500 px 宽的画布），
同时按规范接收宿主提供的原生 `conversation` 节点，把它停靠在右侧（可折叠），
**不自建聊天界面**。根节点的首个子元素是语义 `<header>`，
满足宿主 macOS 顶部拖拽区与 `--dsh-frame-leading-clearance` 规避样式的接缝要求。

---

## 4. 功能入口与交互逻辑

打开方式（沿用宿主既有机制，不新增入口）：

1. 侧栏顶部模式切换器 → 选择「DSH 思维导图」（或「工作台管理」里添加后再打开）。
2. 首次打开时，`dsh-desktop-workbenches` 会把本工作台加入 `state.added` 并记录归属。
3. 进入后画布立即可用——**不需要会话、不需要工作区**（规范第 6 节）。

面板布局与操作：

```
┌ <header> DSH 思维导图 │ [文档 ▾] │ 新建 重命名 创建副本 删除 │ 导出JSON 导入JSON 立即保存 重新载入 ─── ● 已保存 12:34:56 │ 隐藏会话 ┐
├──────────────────────────────────────────────────────────────┬──────────────────────────────┤
│  思维导图画布（上游完整应用：节点操作、主题、结构、图标、        │  原生会话（仅用户主动          │
│  关联线、概要、外框、标记、待办、公式、演示、导出…）            │  选择 AI 协助时才显示）        │
└──────────────────────────────────────────────────────────────┴──────────────────────────────┘
```

**默认只有业务整页**：会话区收起时画布独占主内容区（上图右侧一格不存在）。
这是规范 4.1 对 `customFrame` 工作台的要求——「不要求每个工作台默认提供常驻入口或占据
一块聊天区」「只有当用户主动选择 AI 协助时，才创建或恢复工作台会话并显示会话区；关闭后
回到业务视图」。宿主传入的原生 `conversation` 节点固定停在会话区容器里（收起时用 `hidden`
隐藏），因此开关 AI 协助不会卸载重建宿主的输入树。

| 入口 | 行为 | 数据落点 |
|---|---|---|
| 文档下拉 | 切换文档：服务端设当前文档 → 画布整帧重载 | `documents/<id>.json` |
| 新建 | 命名后创建空白导图并切换 | 同上 |
| 重命名 / 创建副本 / 删除 | 对话框（含焦点陷阱、Esc、遮罩点击关闭、busy 禁用）；默认文档受保护不可删 | 同上 |
| 导出 JSON | 向画布请求快照，导出 `<名称>.dshmm.json`（可再导入） | 浏览器下载 |
| 导入 JSON | 接受本工作台导出的封装 `{ data }` 与裸导图数据 | 新建文档 |
| 立即保存 | 通知画布落盘 + 刷新列表 | 同上 |
| 重新载入 | 丢弃画布内存态，从磁盘重载 | — |
| **AI 协助**（`aria-pressed`） | 显示/收起会话区；收起即回到业务视图，**不销毁会话** | — |
| 状态灯 | 已连接 / 正在保存 / 已保存（含时间）/ 离线告警 | — |
| 首次进入说明（可关闭） | 一行 `role="status"` 提示，说明画布无需会话、要让 Agent 参与时点「AI 协助」；关闭状态记在 localStorage | — |
| 画布内工具栏 | 上游完整能力：结构、主题、样式、节点内容、导入导出（PNG/SVG/PDF/XMind/Markdown/Txt/Xlsx/FreeMind/Mermaid/Html）、演示模式、大纲、小地图、水印、搜索替换… | 画布直接下载文件 |

**无会话时（点开 AI 协助后）显示的是工作台自己的入口**，不是宿主通用无会话引导：
「选择资料位置并开始会话」（`service.newWorkspaceSession()`，由宿主导出目录选择器）
或「在此工作区开始会话」（`service.newSession(workspaceId)`）。首次进入不会自动创建会话。

---

## 5. 新项目结构

```text
DSHMindWorkbench/
├── package.json             # npm + DSH 插件声明（dsh.bundle.patch / dsh.client.*）
├── cordis.patch.yml         # 把服务端入口插入插件树，声明数据目录
├── dsh/index.js             # 服务端入口：静态托管 + 文档接口（唯一权威实现）
├── lib/client.js            # 客户端入口：已构建单文件，React 面板 + 注册
├── app/                     # 内嵌的思维导图静态应用（生成物，勿手改）
│   ├── index.html           #   改造后的宿主页（去统计、开接管、引 bridge）
│   ├── bridge.js            #   应用侧接管桥（源码，随上游契约维护）
│   └── dist/**              #   上游构建产物原样拷贝（281 个文件，约 7.0 MiB）
├── scripts/
│   ├── sync-app.mjs         # 从 ../mind-map-0.20.0 重新生成 app/
│   ├── verify.mjs           # 39 项自检（包 / 服务端接口 / 客户端渲染与规范符合性）
│   ├── smoke.mjs            # 真 HTTP 服务冒烟；--serve 常驻供浏览器界面冒烟
│   ├── stub-loader.mjs + stubs/schemastery.js   # verify/smoke 用的依赖替身
├── README.md
├── INTEGRATION.md           # 本文件
└── LICENSE
```

---

## 6. 对 dsh-desktop 的代码修改说明

全部为**新增**，不修改任何一个既有文件里的既有行为；删除这三处即可完全回退。

### 6.1 `dsh-desktop-0.11.1/package.json`

```diff
     "dsh-desktop-workbenches": "file:packages/dsh-desktop-workbenches",
     "dsh-image-generation": "file:packages/dsh-image-generation",
+    "dsh-mind-workbench": "file:packages/dsh-mind-workbench",
```

```diff
     "loader:generate": "node scripts/generate-loader-gifs.mjs",
+    "mind:sync": "node scripts/sync-mind-workbench.mjs",
```

说明：与仓库内其他自有包一致，走 `file:packages/...`，确保
`electron-builder` 的 `files: ["node_modules/**/*"]` 打包路径与其它插件完全相同。

### 6.2 `dsh-desktop-0.11.1/build/dsh-desktop.patch.yml`（新增一段 insert）

```yaml
# DSH 思维导图工作台（第三方工作台插件，源码在 ../../DSHMindWorkbench）。
# 属规范第 3 节的可选贡献项：加载或渲染失败只隔离该工作台，不阻断原生会话与其它插件。
- insert:
    - id: dsh-mind-workbench
      name: dsh-mind-workbench
      config:
        root: !!js dshHomePath('mind-workbench')
```

未写入 `build/dsh-desktop-safe.patch.yml`：安全模式只加载最小集，本工作台与
PPT / 市场 / 预设传输一样不得成为安全模式的启动依赖。

### 6.3 `dsh-desktop-0.11.1/packages/dsh-mind-workbench/`（生成物）

由 `node scripts/sync-mind-workbench.mjs` 从 `../DSHMindWorkbench` 复制而来
（只含 `dsh/ lib/ app/ cordis.patch.yml package.json README.md INTEGRATION.md LICENSE`）。
该目录是**生成物**，修改请回到上游项目再重新同步——避免出现两份手工维护的实现。

### 6.4 未改动的部分（明确说明）

- `src/main/**`：未改。静态资源由插件的 fetch 路由提供，主进程无需新路径、无需放宽
  任何安全设置（`sandbox` / `webSecurity` / `will-attach-webview` 全部保持原状）。
- `preload`、`patches/`、`test/`：未改。
- 宿主 `dsh-desktop-workbenches` 包：未改。集成只用它公开的 `register` 契约。

---

## 7. 安装与验证

### 7.1 包校验（已执行）

```bash
cd <本仓库>
node scripts/verify.mjs          # 41 项自检
node scripts/smoke.mjs           # 真 HTTP 服务 10 项冒烟
pnpm pack                        # 产出 dsh-mind-workbench-1.0.0.tgz
tar -tzf dsh-mind-workbench-1.0.0.tgz
```

产物：`dsh-mind-workbench-1.0.0.tgz`（约 2.7 MiB，288 个条目）。
校验记录写在同目录的 `dsh-mind-workbench-1.0.0.tgz.sha256`（打包后生成，因而不计入包内，
避免「改文档→包变→哈希变」的循环）。

### 7.2 本机安装能力探测（已执行，结论：当前版本没有本地安装入口）

| 探测项 | 命令 / 位置 | 结果 |
|---|---|---|
| 已安装版本 | 应用目录下的 `DSH Desktop.exe` → 文件版本 | **0.11.1**（ProductVersion 0.11.1.0，DataElement）；运行时 `desktopVersion 0.1.7-rc.2`、node 24.21.0、pnpm 11.7.0 |
| 应用是否在运行 | 进程命令行 | 在运行；Harness 以 `--profile web` 起在 `127.0.0.1:43129` |
| 「工作台管理」本地安装入口 | 0.11.1 源码 `packages/dsh-desktop-workbenches/{client.js,index.js,market-install.mjs}` | **无**。市场的安装源由目录条目的 `distribution.type` 决定，仅 `npm` / `github-release` / `github-source`；`market-install` 路由要求条目 `id` 为市场里的 `owner/repo`。本地包只会作为「本地」工作台被**识别**（`reconcileLocalProviders`），前提是它已被加载 |
| `dsh plugin add` CLI | `DSH Desktop.exe --expose-internals resources\harness-node-entry.mjs app.asar\node_modules\@deepseek-ai\dsh\lib\bin.js --profile desktop plugin --help` | **不可用**：`error: profile "desktop" is managed exclusively by the Electron application` |
| 社区插件市场 dshmarket 1.65.3 | `profiles/desktop/node_modules/dshmarket/lib/sources.js` | 安装目标只来自目录条目（`npm` / GitHub Release tarball / `github:` 源码）。`isLocalSpec()` 只用于**读取已装**的 `link:`/`file:` 规格，不是安装入口 |
| 手工改 profile（`pnpm add` + `dsh.profile.bundles`） | dshmarket 的 `install.js` / `patch.js` 契约 | 技术上可行但属**绕过官方安装路径**；CLI 已明示该 profile 由 Electron 应用独占，故本次**未执行** |

**因此：本次没有可用的本地安装方式，我没有把工作台装进这台 DSH Desktop，
也没有改动它正在使用的 profile（`~/.dsh/profiles/desktop` 保持原样）。**
按规范 3.6 / 9 节，下面所有「安装后」的验收项一律标为**未实测**。

### 7.3 如果要在本机真正装起来，可选的官方途径

1. **把产品方向交回桌面应用自己**：在 DSH Desktop 里用侧栏「工作台管理 → 制作我的工作台」
   发起开发流程，由桌面内嵌的 Agent 在其体系内完成构建与安装。
2. **走市场分发**（需要你授权发布）：把包推到 GitHub 或 npm，再通过「工作台管理」安装。
   那是市场投稿路径，本次任务明确排除。
3. **内置集成**（需重新构建/重装应用，不是往当前安装里加包）：

```bash
cd <dsh-desktop 源码目录>
npm run mind:sync                # 同步到 packages/dsh-mind-workbench
npm install                      # 让 file: 依赖生效
npm run dev                      # 或 npm run build && npm run package:win
```

> 已在本次任务中写入该内置集成所需的 3 处改动（见第 6 节），
> 但当前**已安装的 0.11.1** 用的是应用自带补丁（`resources/dsh-desktop.patch.yml`
> 已核对，不含 `dsh-mind-workbench` 行），所以它对正在运行的应用**不会生效**。

### 7.4 规范第 8 节自测清单逐项状态

**包与加载**

- [x] **插件负责**：第 3 节全部「必须」项通过。`pnpm pack` 产物用 `tar -tzf` 核对：
  `package.json`、服务端入口 `dsh/index.js`、客户端入口 `lib/client.js`、
  `cordis.patch.yml` 均在列，288 条目、无开发期文件混入。
- [ ] **插件负责**：安装并重启后，`dsh --profile web --dump-config` 出现插件层、
  「工作台管理／已安装的工作台」出现条目、左侧入口可打开业务面板 —— **未实测**
  （7.2 已证当前版本无本地安装入口；且该 profile 的 `dump-config` 也被 CLI 拒绝）。

**第 4 节：界面边界**

- [ ] **插件负责**：打开业务面板、缩放窗口、切换原生会话/工作台，确认不遮挡侧栏与
  市场/管理入口；键盘可达业务操作 —— **未实测**（无法加载）。
  已做的静态保证：面板根节点 `overflow:hidden` 填满宿主容器、工具栏按
  `--dsh-frame-leading-clearance` 让位、所有按钮为原生 `<button>` 带 `aria-*`。
- [ ] **customFrame 项**：缩窄窗口操作布局、弹层与拖拽，确认都在宿主主内容区内 ——
  **未实测**。已做的静态保证：对话框是面板内 `position:absolute` 遮罩（不越界），
  未使用窗口最大化或拖拽换位；已断言默认收起会话区、画布独占主内容区。

**第 5–6 节：工作区与会话**

- [x] **仅使用该能力时适用，插件负责**：业务流程需要创建文件/工作区时从业务入口触发
  宿主目录选择器 —— 已实现：只调用宿主服务 `service.newWorkspaceSession()` /
  `service.newSession(workspaceId)`，工作台自身不创建目录；取消时不自建工作区或会话。
  （行为级验证属未实测项。）
- [x] **仅使用该能力时适用，插件负责**：无会话时业务功能可用、发起依赖会话的操作才
  创建/恢复会话、草稿由用户发送 —— 已实现并**静态验证**：`verify.mjs` 断言
  「会话区默认收起、画布独占主内容区，并自带无会话入口」「AI 协助默认关闭」
  「默认收起时仍保留宿主 conversation 节点」。首次进入不自动创建会话。
- [ ] **宿主负责，插件配合核验**：同一工作区里原生会话与两个工作台会话的归属核对 ——
  **未实测**。

**第 7 节：模式切换与保留**

- [ ] **宿主负责**：侧栏模式切换器在「原生会话」与各工作台之间切换、只显示对应会话、
  图标/焦点/折叠状态正确 —— **未实测**。
- [ ] **宿主负责，插件配合核验**：关闭重开、卸载后已有会话/项目文件/草稿仍在 ——
  **未实测**。已做的静态保证：文档写在独立数据目录、卸载不删除数据（服务端无删除目录逻辑）。
- [x] **插件负责**：记录 Desktop 版本、操作系统、架构、包版本、执行的 UI 路径及未验证项 ——
  见 7.2 与本表；包版本 `dsh-mind-workbench@1.0.0`。

### 7.5 其它未实测项

- 画布在真实渲染进程内的加载：iframe 同源策略、CSP（当前 Desktop 未发现全局
  `Content-Security-Policy`；若有需含 `frame-src 'self'`）、`sandbox` 下的
  `localStorage`/`postMessage`/下载行为 —— 浏览器界面冒烟因本机 Chromium 启动失败
  （`Auto-launch failed: CDP response channel closed`）未能执行。
- 画布内「导出 PNG/PDF/XMind/Markdown…」在 Electron 下载链路中的落地位置。
- 上游应用网络不可达时的降级（画布内的 AI 对话需要外网与密钥，本工作台不涉及）。

> 以上未实测项均按规范第 9 节如实标注，**未宣称通过**。

---

## 7.6 更正与补充（依据真机安装证据）

7.2 的结论「当前版本没有本地安装入口」**已被真机证据推翻**：这台机器上确实完成过一次本地安装，
产物落在

```text
%APPDATA%\dsh-desktop\harness\profiles\.generations\live\dsh-mind-workbench+<版本>+<内容哈希>\node_modules\dsh-mind-workbench\
%APPDATA%\dsh-desktop\harness\profiles\web\node_modules\dsh-mind-workbench   ← Junction 投影
```

安装器会把包按「版本 + 内容哈希」建成一代，并在
`profiles\.generations\desired.json` 与 `profiles\web\package.json` 的 `pnpm.overrides` 中登记。

**当时的失败不是安装方式问题，而是包本身的缺陷**：服务端把 `documents` 的 GET 与 POST
注册成两条同路径路由，Harness 的 fetch 路由表按 pathname 唯一（见应用内
`registerFetchRoute`：`if (this.fetchRoutes.has(route.path)) throw …`），
第二次登记抛错；路由登记又挂在插件自己的 effect 上，因此 `apply` 抛错会让该插件
**已登记的全部路由被回收** → `/api/dsh-mind-workbench/*` 全 404。
现象即：工具栏红条「文档：HTTP 404」+ 画布永远停在「正在载入…」。

已修：GET/POST 合并为一条多方法路由并在 `fetch` 内分派；`scripts/verify.mjs` 与
`scripts/smoke.mjs` 的宿主替身复刻了这条唯一性约束（重复路径立即抛错），
并新增 `scripts/check-package.mjs` 覆盖市场验收的自动检查项。

### 第二个、更致命的缺陷：非法路由路径 + 异步抛出

修完重复路由后，真实环境仍然失败，日志为：

```text
unhandled rejection: Error: connection: invalid exact Fetch route
  "/api/dsh-mind-workbench/app/dist/img/%E5%9B%BE%E7%89%87%E5%8A%A0%E8%BD%BD%E5%A4%B1%E8%B4%A5.svg"
dsh: fatal load failure: Error: connection: invalid exact Fetch route "…"
```

两处原因，必须一起修：

1. **路径段字符受限**。应用内真实校验是
   `assertFetchRoute → endpointFromPath('/api', path)`，要求 `/api/` 之后每一段匹配
   `ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/`。
   旧实现用 `encodeURI()` 生成路径，`app/dist/img/图片加载失败.svg` 变成百分号编码 → 判为 invalid。
2. **抛出位置**。该 `register` 发生在 `collectFiles().then(...)` 异步链里，
   抛出后不落在插件 effect 内 → 升级为 **unhandled rejection** →
   `dsh: fatal load failure` → **整个 Harness 退出**（不只是本插件失效）。
   这是「工作台装不上、一直报错」的真正原因。

对应修复：

- `scripts/sync-app.mjs` 增加文件名 ASCII 化：把不合规文件名改成等价 ASCII 名
  （`图片加载失败.svg` → `asset.svg`），并在所有文本产物里同步改写引用；
- `dsh/index.js` 改为**同步**枚举（`readdirSync`），登记前用同一正则校验每一段，
  不合规或重复的路径**只记录并跳过、绝不抛出**；`/health` 增加 `skipped` 字段暴露被跳过的路径；
- 自检增加：`app/` 下不允许出现不合规文件名；所有路由路径必须通过段字符校验；
  静态路由必须在 `apply()` 内**同步**登记完成；两个脚本都注册
  `process.on('unhandledRejection')` 直接判失败。

**安装后的正确步骤**：重装本目录 → 完整退出并重开 DSH Desktop（或菜单「重启 Harness」）→
打开侧栏入口。安装只新增一代产物，**不重启不会生效**。
详细的待办清单见 `docs/market-submission.md`。

---

## 8. 已知限制与可选后续

| 限制 | 原因 | 影响 / 建议 |
|---|---|---|
| 上游 `getConfig()` 在接管模式下 `return` 缺失 | 上游 `web/src/api/index.js:71-75` 的既有缺陷（调用了但没返回） | 主题/结构等**在导图数据内**，仍会随 `getMindMapData` 恢复；仅「实例化配置」不回填。要修需改上游源码并重新构建 |
| 数据是「整份文档每次全量写盘」 | 接管模式的契约就是整份数据交回 | 400 ms 防抖已足够；超大导图（>8 MB）会被服务端 413 拒绝，届时需改为增量或分片 |
| `repository` 目前指向占位仓库 | 本地工作台没有真实远端仓库 | 上架市场前改成真实的 GitHub 仓库并保持一致（身份 = `owner/repo`） |
| 画布快捷键与宿主的键盘冲突 | 焦点在 iframe 内时事件不会冒泡到宿主 | 属浏览器语义，非缺陷；离开画布后宿主快捷键即恢复 |
| 上游构建产物约 7.0 MiB | 包含 265 个主题/节点素材图 | 本机与内置集成无限制；上架市场需注意规范建议的 8 MiB 上限 |
| 画布不支持宿主深色令牌 | 上游应用自带主题体系，与本工作台的 `--dsw-alias-*` 无关 | 面板外壳随宿主主题自动切换；画布外观由画布自己的主题设置决定 |

可选后续（当前未做，避免过度设计）：

1. 把上游「AI 对话」能力接到 DSH 会话（通过 `command` 消息或宿主会话接口）；
2. 导出产物直接写入 DSH 工作区（需接入宿主的目录选择器与文件服务）；
3. 支持把 DSH 会话内容一键生成为导图节点。
