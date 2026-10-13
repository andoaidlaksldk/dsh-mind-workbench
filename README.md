# DSHMindWorkbench · DSH 思维导图工作台

把一套完整的内嵌思维导图画布应用集成为 [DSH Desktop](https://dshdesktop.com/) 的一个工作台模块。

- 画布原有功能**零改动、零重写**：画布、节点操作、主题、结构、图标、关联线、概要、外框、
  标记、待办、公式、演示模式、大纲编辑、小地图、水印、搜索替换，以及画布自带的全部导出格式：
  **导图文件（.smm，可再次导入）、图片（PNG）、SVG、PDF、Markdown、XMind、Txt、JSON**（共 8 种）。
- 数据不再存在浏览器 localStorage，而是落到 DSH 数据目录，并自带文档管理。
- 面板是纯 React 组件，遵循《工作台开发规范》（2026-10-09 版）：`customFrame` 业务整页布局、
  **会话区不常驻**（仅用户主动点「AI 协助」时创建/恢复会话并显示，关闭后回到业务视图）、
  不显示宿主通用无会话引导、中英文文案、`--dsw-alias-*` 语义色、样式幂等注入、错误隔离。

集成原理、交互逻辑、对 dsh-desktop 的逐文件修改与「已实测 / 未实测」清单见
[INTEGRATION.md](./INTEGRATION.md)。

## 目录

```text
package.json       npm + DSH 插件声明（dsh.bundle.patch / dsh.client.*）
cordis.patch.yml   把服务端入口插入 Harness 插件树
dsh/index.js       服务端入口：托管 app/ + 文档存取接口
lib/client.js      客户端入口：注册工作台面板（已构建单文件）
app/               内嵌的思维导图静态应用（生成物）
                   index.html（宿主页）· bridge.js（接管桥）· dist/**（画布构建产物）
scripts/           sync-app.mjs（重建 app/）· verify.mjs（自检）
```

## 数据位置

由 `cordis.patch.yml` 的 `dshHomePath('mind-workbench')` 决定：

```text
<DSH_HOME>/mind-workbench/
├── state.json            当前文档、语言、实例化配置、本地配置
└── documents/<id>.json   每个思维导图一份（含 id/name/data/时间戳）
```

卸载本工作台不会删除这些文件。

## 开发

```bash
# 重建内嵌应用（画布源码的构建产物发生变化后执行）
node scripts/sync-app.mjs                 # 默认读取 ../mind-map-0.20.0
node scripts/sync-app.mjs --source ../mind-map-0.20.0

# 自检：包完整性 + 服务端接口真跑 + 客户端渲染与规范符合性（66 项）
node scripts/verify.mjs

# 冒烟：真起 HTTP 服务打一遍画布启动与保存链路（10 项）；
# 加 --serve 常驻服务，配合浏览器做界面冒烟（--check-disk <关键字> 校验落盘）
node scripts/smoke.mjs

# 打包（工作台规范 3.6）；装法取决于当前 Desktop 版本是否提供本地安装入口
pnpm pack
```

## 服务端接口

| 方法与路径 | 说明 |
|---|---|
| `GET /api/dsh-mind-workbench/health` | 健康检查（托管文件数、文档数、数据目录） |
| `GET /api/dsh-mind-workbench/app/**` | 托管的内嵌应用（装载期逐文件注册） |
| `GET /api/dsh-mind-workbench/session` | 当前文档 + 偏好设置（画布启动数据源） |
| `POST /api/dsh-mind-workbench/session/data` | 回写当前文档数据（防抖自动保存） |
| `POST /api/dsh-mind-workbench/session/preferences` | 保存语言 / 实例化配置 / 本地配置 |
| `GET /api/dsh-mind-workbench/documents` | 文档列表 |
| `POST /api/dsh-mind-workbench/documents` | `create` / `open` / `rename` / `duplicate` / `import` / `delete` |

## 来源与声明

本项目是基于开源思维导图画布项目的**二次开发**：画布本身的业务代码未做改动，
数据存取、文档管理、工作台面板与 Agent 读写成导图的工具由本工作台提供。
第三方许可与出处见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

## 许可

本包 MIT（见 [LICENSE](./LICENSE)）；内嵌画布及其依赖的许可与出处见
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
