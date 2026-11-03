# Folio

开源的 Chrome / Edge 网页翻译扩展，支持 ChatGPT 登录和 OpenAI Chat Completions 兼容 API。

优先翻译当前屏幕，逐段显示译文；支持按网站自动翻译、动态网页、双语 / 仅译文、自定义样式、本地缓存和恢复原文。

## 安装

需要 **macOS 或 Linux、Chrome 或 Edge、Node.js 22.12 及以上版本**。目前通过开发者模式加载，尚未上架扩展商店。

```bash
git clone https://github.com/linksyou/folio.git
cd folio
npm ci
npm run check
npm run install:host -- --browser chrome
```

然后在浏览器中完成加载：

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择项目中的 **`dist/extension`** 文件夹，不是项目根目录或 `dist`。如果已从该目录加载 Folio，点击「重新加载」即可。
3. 打开 Folio 设置，确认页面显示「本地程序已连接」。若显示未连接，检查 Host 安装命令是否成功、浏览器参数是否正确，再点击「重新检测」。

Edge 用户将安装命令末尾的 `chrome` 改为 `edge`，并在 `edge://extensions` 中加载。两个浏览器都使用时，改为 `all`。

本地辅助程序由浏览器自动启动，日常使用不用开着终端。请保留项目文件夹和 Node.js，浏览器需要读取扩展目录。

如需代理，本地辅助程序支持 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`（小写优先）。macOS 浏览器启动的辅助程序通常不继承终端环境变量；未设置 HTTP/HTTPS 代理变量时，会读取系统中启用的静态 HTTP/HTTPS 代理及绕过规则。修改代理设置后，请在扩展管理页重新加载 Folio。系统 PAC 自动代理和仅 SOCKS 配置暂不自动读取；可改用静态 HTTP/HTTPS 代理。HTTPS 证书校验始终保留。

也可以把下面这段话交给具备终端和浏览器操作能力的 Agent：

> 请阅读 https://github.com/linksyou/folio 仓库中的 README.md 和 AGENTS.md，检查本机环境，帮我安装 Folio，并完成需要在浏览器中完成的操作。

Agent 应继续完成扩展加载和本地程序连接检查。若工具无法操作扩展管理页或系统文件选择器，应说明限制，并给出需要接手的具体步骤和扩展目录的绝对路径。ChatGPT 登录或 API Key 填写由你在设置页亲自完成；安装与连接检查不代表已经验证实际翻译。

## 使用

1. 打开扩展设置，选择 ChatGPT 并完成登录，或填写自定义 API 地址、模型和 API Key。ChatGPT 的可用性、模型和额度取决于账号与服务；自定义 API 地址应类似 `https://example.com/v1`，无需添加 `/chat/completions`。
2. 打开网页，点击扩展中的「翻译正文」。也可使用网页悬浮图标或快捷键 `Alt+A`；`Alt+R` 恢复原文。
3. 想自动翻译当前网站，可开启「此网站自动翻译」并授权。语言、显示模式、颜色和缓存可在设置中调整。

网页正文会发送至你选定的模型服务，可能产生用量。凭证保存在本机；完整译文会缓存在浏览器中，可在设置中关闭或清除。项目不提供中转服务器。目前不支持 Windows 安装、PDF、iframe、Shadow DOM、OCR 和视频字幕。

## 更新与卸载

更新时在项目目录运行：

```bash
git pull --ff-only
npm ci
npm run check
npm run install:host -- --browser chrome
```

然后在扩展管理页点击「重新加载」，刷新已打开的网页和设置页。Edge 用户同样替换浏览器参数。

卸载时先从浏览器移除扩展，再运行 `npm run uninstall:host -- --browser chrome`。卸载辅助程序会保留 `~/.local/share/folio/data/` 中的账号和设置。

## 源码

`src/extension/` 是浏览器扩展，`src/host/` 是本地辅助程序，`src/shared/` 是共享协议，`scripts/` 包含构建和安装脚本。依赖由 `package.json` 和 `package-lock.json` 管理，通过 `npm ci` 安装。

Agent 安装与维护说明见 [AGENTS.md](AGENTS.md)。代码采用 [MIT License](LICENSE)。

网络代理与模型目录回归测试：`npm test`；类型检查和构建：`npm run check`。自动化测试使用本机模拟服务，不读取账号凭据或调用真实模型。
