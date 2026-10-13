# 模型配置教程（画布 AI）

本工作台内嵌的思维导图应用带 AI 能力（AI 一键生成导图、AI 对话）。
画布源码画布原本把 AI 请求发到「本地桥」（闭源客户端，默认 `localhost:3456`），Web 版因此**不可用**；
本工作台**自己实现了这个桥**，并把请求改走同源接口，所以：

- 不需要安装任何闭源客户端；
- 可以选择**多家供应商**（凡提供 OpenAI 兼容接口的都可用）；
- API Key 只保存在本机数据目录，不经过第三方。

## 一、在哪里配置

打开工作台面板右上角的 **「模型配置」**，填写四项后点「保存」：

| 字段 | 说明 | 示例 |
| --- | --- | --- |
| 供应商 | 从预设里选；选「自定义」可手填地址 | DeepSeek |
| 接口地址 | 供应商的 OpenAI 兼容 base URL | `https://api.deepseek.com/v1` |
| API Key | 供应商控制台创建的密钥 | `sk-…` |
| 模型名 | 该供应商的模型标识；火山方舟填**推理接入点 ID** | `deepseek-chat` |

点「测试连接」会保存配置并发一次只取 1 个 token 的真实请求，用来确认地址、密钥、模型名都对。

> 配置存在 `<DSH 数据目录>/mind-workbench/state.json` 的 `aiProvider` 字段里，只在本机。

## 二、常用供应商参数

| 供应商 | 接口地址（base URL） | 模型名示例 | 备注 |
| --- | --- | --- | --- |
| 火山方舟（豆包） | `https://ark.cn-beijing.volces.com/api/v3` | `ep-…` | 必须填**推理接入点 ID**，不是模型名 |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | 需要可访问的网络 |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | |
| 阿里云通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 走 OpenAI 兼容模式 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` | |
| Ollama（本地） | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` | 本地跑模型，不需要 Key |
| 自定义 | 任何 OpenAI 兼容地址 | 任意 | 只要实现 `POST {base}/chat/completions` |

> 接口地址填到 `…/v1` 这一级即可，本工作台会自动补 `/chat/completions`；
> 若你直接粘贴了完整的 `…/chat/completions`，也会原样使用。

## 三、画布里的「教程」链接

画布「AI 配置」弹窗里的「教程」链接**已指向本页**（画布源码原本指向一篇微信公众号文章）。
本页由 `docs/ai-model-setup.md` 生成到包内的 `app/docs/ai-model-setup.html`，离线可看。

## 四、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 提示「尚未配置模型接口」 | 还没保存模型配置，或供应商选了「自定义」但接口地址为空。 |
| 提示「模型接口返回 HTTP 401」 | Key 不正确、已删除，或该 Key 没有对应模型的权限。 |
| 提示「模型接口返回 HTTP 404」 | 接口地址少了或多了路径（例如忘了 `/v1`）。 |
| 提示模型不存在 | 模型名写错；火山方舟要把 `ep-…` 接入点 ID 填进「模型名」。 |
| 一直无响应 | 网络无法访问该供应商；公司网络或代理可能拦截。 |
| 费用怎么算 | 由各供应商按其规则计费，与本工作台无关，本工作台不收费。 |
| 换机器还能用吗 | Key 存在本机数据目录，换机器需重新填写。 |

## 五、安全说明

- API Key 只存在本机数据目录，由本工作台转发请求时使用，不会上传到其他地方。
- 本工作台**只转发**请求，不记录对话内容。
- 转发目标仅允许 `http`/`https`，其他协议（如 `file:`）会被拒绝。
- API Key 等同于账号调用凭证：不要写进截图、文档或提交到代码仓库。
