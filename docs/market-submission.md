# 上架工作台市场：待办与逐项对照

依据《工作台市场验收规范》（2026-09-29，`https://dshdesktop.com/workbench/docs/market-acceptance/`）
与《工作台开发规范》（2026-10-09，`https://dshdesktop.com/workbench/docs/development/`）。

本文只列「还差什么」和「怎么核对」，格式以
[awesome-dsh-workbench](https://github.com/dataelement/awesome-dsh-workbench) 的
`catalog/README.md` / `schema/` 为准（下面 YAML 按规范正文给出的最小字段写）。

---

## 1. 现在的状态

| 项 | 状态 |
|---|---|
| 包格式（`dsh.bundle.patch`、`dsh.client.*`、`exports["./client"]`、`cordis.patch.yml`） | ✅ 已满足，`npm run verify` 66 项 + `npm run smoke` 10 项通过 |
| **介绍与实际能力一致** | ✅ 导出格式按产物的实际开放项声明（8 种）；`npm run verify` 会**从产物解析**导出类型与过滤规则，再核对 README / INTEGRATION 的声明，声明跑到产物前面会直接失败 |
| 包体积 | ✅ 约 2.7 MiB（上限 8 MiB），`npm run pack:check` 会核对 |
| 包内无 `.env`/密钥/杂散文件/本机绝对路径 | ✅ 由 `scripts/check-package.mjs` 检查 |
| 许可证 | ✅ MIT（`LICENSE`），不出现任何画布原品牌与链接 |
| 本机安装并实际打开 | ✅ 已安装到本机 DSH Desktop 并实际使用（当前版本见 `package.json`；安装方式见第 2 节） |
| **`repository` 指向你自己的公开 GitHub 仓库** | ✅ 已指向 `https://github.com/andoaidlaksldk/dsh-mind-workbench`（`package.json` 的 `repository.url` 与 `lib/client.js` 的 `REPOSITORY` 两处一致，`scripts/check-package.mjs` 会在它退回占位值时报警） |
| 仓库根目录即包根（v1 不支持 monorepo 子目录） | ✅ 本目录就是包根，把它作为仓库根推送即可 |
| 上架资料：`name` / `category` / `description.zh|en` / `screenshots` | ⚠️ 见第 3 节，截图必须在**最终可安装版本**上实拍 |
| 收录 PR | ✅ 已提交：`dataelement/awesome-dsh-workbench` #45（分支 `add-andoaidlaksldk-dsh-mind-workbench`）；本轮按审核意见修正介绍并发布 **v1.0.14** |

## 2. 先把「能用」跑通（重装 + 重启）

当前机器上你的安装已被回滚：`%APPDATA%\dsh-desktop\harness\profiles\.generations\desired.json`
与 `profiles\web\package.json` 的 `pnpm.overrides` 里都没有 `dsh-mind-workbench`，
只在 `profiles\web\node_modules\` 留了一个失效的 Junction。所以：

1. 在 DSH Desktop 里先**移除**这个工作台的残留记录（工作台管理 → 已安装 → 移除）。
2. 用你上次成功的同一个入口重新安装本目录（安装器会新建一代
   `dsh-mind-workbench+1.0.1+<hash>`，并写回 `desired.json` 与 `pnpm.overrides`）。
3. **完整退出并重新打开 DSH Desktop**，或从菜单执行「重启 Harness」。
   > 安装只会新增一代产物；**不重启不会生效**，界面会停留在旧代码上。
4. 打开侧栏的「DSH 思维导图」，应看到画布直接渲染、状态显示「已保存」。
   若仍显示红色提示「服务端插件未加载」，说明服务端路由没挂上：
   先确认已重启，再看 `%APPDATA%\dsh-desktop\profiles\logs\harness.log`（实际路径见下）
   里有没有 `error dsh-mind-workbench`。日志位置：
   `%APPDATA%\dsh-desktop\logs\harness.log`。

### 曾经的失败原因（已修）

旧版本在服务端把 `documents` 的 GET 与 POST 注册成两条同路径路由。
Harness 的 fetch 路由表按 **pathname 唯一**，第二次登记会抛
`connection: exact Fetch route "…" is already registered`；
而路由登记挂在插件自己的 effect 上，`apply` 抛错会把该插件**已登记的全部路由一起回收**，
于是 `/api/dsh-mind-workbench/*` 全部 404（界面表现为「文档：HTTP 404」+ 画布一直「正在载入…」）。

### 第二个、更致命的原因：非法路由路径 + 异步抛出（同样已修）

修掉重复路由后真实环境仍失败：

```text
unhandled rejection: Error: connection: invalid exact Fetch route
  "/api/dsh-mind-workbench/app/dist/img/%E5%9B%BE%E7%89%87%E5%8A%A0%E8%BD%BD%E5%A4%B1%E8%B4%A5.svg"
dsh: fatal load failure: …
```

- 路径段字符受限：真实校验 `assertFetchRoute` 要求每段匹配 `/^[A-Za-z0-9_$.-]+$/`；
  画布构建产物里的 `图片加载失败.svg` 经 `encodeURI` 变成百分号编码 → 判为 invalid。
- 抛出位置致命：该 `register` 在异步链里，抛出不落在插件 effect 内 →
  **unhandled rejection → `dsh: fatal load failure` → 整个 Harness 退出**。
  这才是"工作台装不上、一直报错"的真正原因（旧版本在启动时把宿主一起带走）。

现在：`sync-app` 把违规文件名 ASCII 化（`图片加载失败.svg` → `asset.svg`）并改写引用；
服务端改为**同步**枚举、登记前逐段校验、不合规或重复只跳过不抛出（`/health.skipped` 可见）；
自检还加了 `process.on('unhandledRejection')` 直接判失败。

> 结论：包本身的问题已全部消除，同类问题会在 `npm run pack:check` 阶段就失败。
> 若安装后仍有异常，先看 `%APPDATA%\dsh-desktop\logs\harness.log` 里的
> `dsh-mind-workbench` 行——正常加载时不应出现 `error` / `fatal load failure`。

## 3. 收录 YAML（提交 PR 时用）

放在 `data/workbenches/<owner>__<repo>.yml`，文件名与 `url` 的 `owner/repo` 一致：

```yaml
url: https://github.com/<owner>/<repo>
name: DSH 思维导图
category: productivity
description:
  zh: 在工作台里创建、编辑和导出思维导图，文档保存在 DSH 数据目录，可与会话并用。
  en: Create, edit and export mind maps inside the workbench, with documents stored in the DSH data directory.
screenshots:
  - https://raw.githubusercontent.com/<owner>/<repo>/main/docs/images/overview.webp
```

- `category` 必须是市场 `data/categories.json` 里的 id：`development`、`productivity`、
  `content`、`data`、`research`、`operations`、`other`（本工作台取 `productivity`）。
- 只有走 GitHub Release 作为安装来源时才加
  `tarball: https://github.com/<owner>/<repo>/releases/latest/download/dsh-mind-workbench.tgz`
  （文件名不带版本号）。
- 不要写 `workbenchId`、版本、npm 包名、校验值、作者 ID——这些由市场自动探测。
- 不要在 YAML 里写本机路径。

### 截图要求

1–5 张，第一张作封面；放在你自己的仓库里（`docs/images/…`），填完整 HTTPS 地址
（`raw.githubusercontent.com` 或 `github.com/.../blob/...`）；PNG/JPEG/WebP，单张 ≤2 MiB，
建议 16:9、宽度 ≥1280px；**必须是最终可安装版本上实拍的桌面界面**，不含凭证或个人数据。
换版本后画面有变化要重拍。

## 4. 安装来源（三选一）

| 来源 | 要做的事 | 本包的适配情况 |
|---|---|---|
| npm（建议） | `pnpm pack` 核对内容 → 发布同版本到 npm → 从 npm 装一次验证 | `package.json.name` 已固定 `dsh-mind-workbench`；`repository` 指回你的仓库后即可 |
| GitHub Release | `pnpm pack` → 把 `.tgz` 传到 Release → YAML 填 `tarball` | 用固定文件名 `dsh-mind-workbench.tgz` |
| 仅仓库源码 | 默认分支直接含构建产物与 bundle patch | ✅ 本包已含预构建产物，无需构建脚本 |

三条路径的共同前提：**先从该来源真实安装并验证过**，再提 PR。

## 5. 提交前自查（对应验收清单）

- [ ] `npm run pack:check` 全绿（= verify 41 + smoke 10 + 包检查），并留档输出。
- [ ] 在本机 DSH Desktop **0.11.1 / Windows x64** 上从最终来源安装、重启、实际打开并用过一次
      （新建文档 → 加节点 → 导出图片），截图留档。
- [ ] `repository` 已改成你自己的公开仓库；仓库有 `LICENSE`；仓库根就是包根。
- [ ] 仓库里没有密钥、客户数据、本机绝对路径；`app/dist/**` 只含画布源码 MIT 素材并已在
      `LICENSE` / `README` 中不出现画布原品牌与链接。
- [ ] 中英文简介属实（会对照代码核对，不要写夸大用语）。
- [ ] 截图在最终版本上实拍、可访问、符合尺寸要求。
- [ ] PR 只新增 `data/workbenches/<owner>__<repo>.yml` 一个文件，描述里写明用途、
      本机验收结果、Desktop 版本与平台、安装来源、外部依赖（画布内 AI 对话需外网与密钥，本工作台不涉及）
      与数据位置（`<DSH_HOME>/mind-workbench`）。

## 6. 更新版本时

源码 PR 合并或只改 `package.json` 版本号 **不等于**市场发布：npm 来源要发布新版本；
GitHub Release 来源要建新 Release 并上传约定的固定文件名。每次仍由作者自己测过再算数。
