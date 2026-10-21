# 贡献指南

感谢你改进 Open Web Translator。提交变更前，请确认改动符合“网页正文、按需授权、原页面可恢复”的边界；当前范围包含按站自动翻译、动态正文、同源 SPA、目标语言与双语/仅译文，详见 docs/IMPLEMENTATION.md。

## 开发环境

需要 Node.js 22.12 或更高版本。

```bash
npm ci
npm run check
```

常用命令：

```bash
npm run typecheck
npm test
npm run build
```

`npm run check` 会依次执行类型检查、自动化测试和构建。不要提交 `dist/`、本地凭证、API Key、token 或真实网页正文样本。

## 代码职责

- `src/extension/page/`：正文识别、页面状态和译文 DOM
- `src/extension/background.ts`：扩展消息路由、标签页任务身份和 Native Messaging 连接
- `src/host/`：本地设置、认证、请求队列和模型适配器
- `src/shared/`：跨边界协议、公开错误和稳定扩展身份
- `scripts/`：构建与本地辅助程序安装
- `tests/`：协议、认证、页面、模型和安装行为测试

页面脚本不能接收凭证，也不能决定任意请求地址。模型返回内容必须作为文本写入页面，不执行 HTML。新增跨进程字段时，应先更新 `src/shared/protocol.ts`，再补齐发送方、接收方和边界测试。

## 变更要求

- 修复状态问题时，明确任务的 `jobId`、页面代次和 `settingsRevision`。
- 外部请求失败应返回稳定错误码，不能把包含请求正文或凭证的 provider 响应直接传给页面。
- 凭证或设置落盘必须保持私有权限和原子替换。
- 新依赖应说明用途并检查许可证。项目采用 MIT；不要复制 OpenAI Sign in with ChatGPT DevKit 的受限代码。
- 不要把尚未执行的真实账户、浏览器或计费验证写成已通过。

## 提交前检查

提交说明应写清用户可见变化、状态边界和验证命令。涉及网页 DOM 时，至少覆盖恢复、迟到响应和原页面不被破坏；涉及认证或设置时，至少覆盖失败恢复、凭证不泄露和原子保存。
