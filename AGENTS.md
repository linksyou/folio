# Agent 说明

本仓库包含 Folio 的扩展、本地辅助程序和必要构建脚本。先阅读 README.md，按用户请求安装或修改；默认用中文交流。

## 帮用户安装

1. 检查系统、目标浏览器和 `node --version`。安装器支持 macOS / Linux，需要 Node.js >= 22.12；Windows 暂不支持。若缺少前置软件，明确告知，不擅自修改系统安全设置。
2. 将仓库克隆到持久目录。已有目录先检查 Git 状态，保留用户修改；不要覆盖目录或执行 `git reset --hard`、`git clean`。
3. 在项目目录依次运行 `npm ci`、`npm run check`、`npm run install:host -- --browser chrome`。按用户浏览器替换为 `edge` 或 `all`；未指定时默认 Chrome。安装失败时读取错误，不重复覆盖无关文件。
4. 确认生成 `dist/extension/manifest.json` 和 `dist/host/main.cjs`，安装命令成功。将 `dist/extension` 的绝对路径交给用户，指导其在扩展管理页开启开发者模式并加载目录。不要声称命令行已完成浏览器扩展加载，也不要通过修改浏览器配置绕过确认。
5. 用户在设置页选择模型连接，并亲自完成登录或密钥填写。不要要求用户在聊天中发送 token、密码或 API Key。未经请求，不发起会发送网页正文或产生模型用量的测试。
6. 分别报告构建、Host 安装、浏览器加载和实际翻译的已验证状态；待用户完成的步骤要标明。

## 更新与卸载

- 更新前检查本地改动；工作区干净且用户要求更新时，使用 `git pull --ff-only`，再运行安装流程。提醒用户重新加载扩展并刷新网页。若 Node.js 路径改变，重新安装 Host。
- 卸载使用 `npm run uninstall:host -- --browser chrome`（或 `edge` / `all`）。用户数据默认保留，不自动删除 `~/.local/share/folio/data/`。

## 维护源码

- `src/extension/page/`：正文提取、调度、译文与恢复；`src/extension/background.ts`：消息路由和 Native Messaging。
- `src/host/`：认证、配置、请求队列及模型接口；`src/shared/`：协议与校验。
- `scripts/build.ts`：构建扩展与自包含 Host；`scripts/install-host.ts`：安装和浏览器注册。
- 修改源码，不直接改 `dist/`。保留既有图标和稳定扩展身份，保持扩展与 Host 协议一致。
- 页面脚本不得接收凭证或指定任意模型请求地址；模型输出作为文本写入，不执行 HTML。不要复制受限代码，不提交凭证、本地数据、依赖目录或生成产物。
- 保留流式翻译、动态正文、任务取消和恢复原文；迟到响应不得写入已停止或已切换的页面。显示设置不得触发不必要的重新生成。
- 完成修改后运行 `npm run check`。该命令只做类型检查和构建，**不包含自动化测试或真实翻译验证**；不要将构建成功描述为完整功能验收。DOM、认证和安装变更还需针对性验证，并如实报告范围。
