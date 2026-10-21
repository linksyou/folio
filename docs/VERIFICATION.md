# 验证说明

本项目把静态检查、自动化测试、隔离浏览器验证和真实 ChatGPT 账户验证分开记录。前一层通过不能证明后一层已经完成。

## 自动化检查

在 Node.js 22.12 或更高版本运行：

```bash
npm ci
npm run check
```

`npm run check` 包含：

- TypeScript 严格类型检查
- Node 测试套件
- Chrome 120 目标的扩展构建
- Node 22 目标的自包含 `dist/host/main.cjs` 构建

测试覆盖的主要边界包括：

- OAuth state、nonce、签名、取消、profile 切换和 token 刷新
- 旋转 refresh token 的并发锁与原子保存
- 认证与设置存储使用独立锁，互相保存不会破坏锁释放
- Native Messaging 分帧、请求校验和错误脱敏
- 请求队列并发与取消
- ChatGPT SSE 跨网络分块解析、单段纯文本进度和完成事件
- 模型目录的 profile 隔离、短期缓存、名称回退和思考档位请求形状
- 自定义 Chat Completions 请求与完整结束条件
- 设置页账号切换、保存竞态、未知模型已存档位和离线恢复
- 正文根节点与标题选择、长段切分、视口优先、方向性预取、停留时整页续译、隐藏页串行续译与返回后重排
- 单段流式预览、完成后计数与缓存、远屏批次取消、批次失败和迟到结果
- 页面缓存与跨刷新 IndexedDB 缓存、强制绕过、恢复和 URL/原文/生成版本隔离
- 缓存 TTL/容量/LRU、开关与按站清除、在途清除防回填、不可用时降级及不谎报清除成功
- 相同文本共享请求、每个订阅者的 ID/进度映射、独立取消和最后订阅者取消底层批次
- 多段流式 JSON 增量解码、Unicode/转义边界、ID 完整性、终态校验和按 ID 合并
- Host 总期限覆盖排队，Native 超时的无递归取消，慢预热的前台等待预算
- 初始空正文、动态追加/改文/删除、body 替换、版本回退和同批取消重排
- 按站规则与注册、权限撤销竞态、同 document SPA 导航、停止后不复活
- 目标语言持久化，显示方式独立本地迁移/即时应用；相同生成配置、只改显示或保存失败不取消已有流
- 生成设置串行保存与状态读取/派发/最终提交的版本一致性
- 保守语言过滤、简繁和多脚本区分、错误 lang 不漏译、跳过独立计数、强制绕过与动态原文/lang 重评估
- 仅译文恢复与交互原段保护
- 连续原文范围、表格单元格、嵌套列表与 BR 边界；相同文字的节点替换/重排/边界变化仍拒绝旧结果
- 仅译文模式宿主可见、原节点身份恢复、宿主修改或清空暂存文本后不被旧备份覆盖
- 译文外观的本地自动保存、失败提示、读取与修改竞态、已翻译网页即时切换，以及不触发重译或改变原文
- 自定义文字/背景配色的 input 即时预览、连续写入合并、主题切换、分别恢复默认、旧配置兼容与非法 CSS 值过滤
- popup 状态轮询与用户动作的竞态保护，整页完成后仍可停止动态监听
- 弹窗单次连接预热、等待中的点击、预热失败回退、不带鉴权或正文、并发 POST 连接复用
- 配置读取与脚本注入并行，两项成功且配置有效后才派发任务
- 准备中的开始操作被停止或恢复打断、导航刷新清理旧任务
- Native Messaging 安装路径、安全覆盖和卸载保留数据

这些测试使用本地构造的响应，不会登录真实 ChatGPT 账号，也不会产生模型费用。

本轮缓存、显示分离和语言过滤的最终 `npm run check` 为 **414/414 项 Node 测试**，类型检查与构建通过；完整浏览器、布局专项和设置页预览通过。各阶段及请求数量的实际结果见 [实现记录](IMPLEMENTATION.md)。测试数量会随项目变化，判断后续工作树应以重新执行 `npm run check` 的结果为准。

布局专项运行 `npm run test:placement`，使用隔离 Chromium、当前 PageTranslator 源码和内存 mock。它检查流式到完成的节点/锚点一致、嵌套列表顺序、单元格内回写、Flex/Grid 原项数量和几何包含、动态新增及恢复全部原节点。截图和结果写入 `test-results/placement/`，不访问网络或模型。

## 设置页 HTTP mock 预览

先构建扩展，再通过本机临时 HTTP 服务预览设置页：

```bash
npm run build
npx tsx tests/options-preview.ts
```

脚本从 `dist/extension` 提供设置页，并注入只用于预览的 `chrome.runtime` mock。它检查已登录模型目录、自定义 API、离线状态、桌面与移动宽度以及深色模式是否发生横向溢出，并把截图写到忽略提交的 `test-results/options-preview/`。这项测试不启动 Native Messaging Host、不读取真实凭证，也不发起模型请求；它只能验证设置页的响应式布局和模拟状态展示。

脚本还调用 `tests/select-preview.ts`，实际点击展开选择框，覆盖上下定位、短视口限高滚动、320/390px 深色模式、长模型/域名、键盘提交与取消、离线禁用、强制高对比度及减少动态效果。几何与操作结果写入 `select-result.json`，展开截图为 `select-*.png`。该组要求测试 Chromium 支持 `appearance: base-select`；产品采用渐进增强，Chrome 120–134 仍使用系统原生菜单，不能将新版选择框的视觉结果当作旧版浏览器的验收。

## 真实延迟诊断

仓库提供显式诊断命令，用固定公开短句经过真实 `HostService`、认证短路径、provider 和模型连接测量各阶段：

```bash
# 两个连续样本；第二个样本用于观察立即复用
npm run diagnose:latency -- 2 0

# 三个样本，每次相隔 15 秒
npm run diagnose:latency -- 3 15000

# 先预热连接，分别计算准备耗时与点击到首字
npm run diagnose:latency -- 2 15000 --prepare

# 使用 Node 默认 fetch 作为连接生命周期对照
npm run diagnose:latency -- 2 6500 --default-fetch
```

样本数只能是 1–5，间隔只能是 0–30000 毫秒。每个样本都会使用当前保存的 ChatGPT 配置发送一次真实模型请求并产生实际用量；运行前应确认账号、模型和用量状态。命令不会输出或写入 token、请求头、固定输入正文、模型返回正文或完整 provider 错误，只记录阶段耗时、状态、所选模型、思考档位和 token 用量数字。默认结果写入忽略提交的 `test-results/latency-diagnostic.json`。

这条路径从 `HostService.status()` 开始，不包含浏览器 IPC、Native Host 进程冷启动、页面提取和 DOM 更新。`requestSent` 之后到首个 delta 的时间仍同时包含网络往返、OpenAI 侧排队和模型处理，不能解释为纯 GPU 推理时间。诊断方法、已保存样本和当前连接池结论见[延迟诊断](LATENCY.md)。

## 隔离浏览器端到端验证

仓库提供 `npm run test:browser`，用于在隔离 Chromium profile 中加载 `dist/extension`，通过独立 Native Messaging 注册目录连接本地辅助程序，并使用本地 mock Chat Completions API 完成网页翻译闭环。

该脚本使用真实扩展、真实本地进程、真实标准输入输出消息和本机 mock 模型响应。截图和机器可读结果写入忽略提交的 `test-results/`。具体浏览器版本和最终运行结果应以本次执行产生的 `browser-result.json` 与控制台输出为准，不在本文写死。

运行命令：

```bash
npx playwright install chromium
npm run build
npm run test:browser
```

测试把构建产物复制到临时目录，只对测试副本加入 `http://127.0.0.1/*` 页面访问权限，代替真实用户点击浏览器工具栏授予 `activeTab`。正式 manifest 默认不授予常驻网站权限；新增可选网站权限，只在用户启用该站自动翻译时申请。测试不修改日常浏览器配置，也不能证明真实用户工具栏操作、Edge 或远程模型已验收。

关闭站点规则的场景明确覆盖 Chrome 拒绝移除测试副本 required localhost 权限：断言 `PERMISSION_REMOVE_FAILED`、本地规则关闭、注册消失、当前任务停止与刷新无请求，不把它描述成 optional 权限气泡验收。

覆盖与后续手动验收项：

1. 浏览器能自动启动 wrapper 和 `dist/host/main.cjs`。
2. 设置页能保存 custom base URL、模型和可选 API Key。
3. 普通文章页先显示当前视口附近的逐段译文，不滚动也继续处理其余正文，动态新增和改文自动入队，链接和代码保持可用。
4. popup 关闭或切换标签页后翻译继续，返回时进度已推进；后台后续请求串行，总并发不超过 2。
5. 停止、失败重试、恢复后缓存复用、强制重译和迟到响应保护符合页面状态。
6. 网站规则启用后刷新自动翻译，同源 SPA 的 push/replace/back/forward 自动衔接，停止/恢复后本页不复活，关闭规则后刷新不再自动翻译。
7. 目标语言进入模型指令；仅译文完成后隐藏简单原段，恢复时原节点和事件保持可用。
8. 卸载移除 Native Messaging 注册，但保留用户数据。

流式场景会让本地 API 在发送首段增量后保持两个请求未结束，检查预览已显示但完成计数仍为零。随后滚动到文章末尾，断言旧 HTTP 流已取消，且新屏幕在旧请求主动结束之前收到预览；停止后未完成预览必须消失，迟到结果不能重新显示。脚本同时记录本地 mock 的首次预览和滚动后预览耗时，这些数值只用于检查扩展链路，不代表真实模型速度。

停留续译场景在首屏完成后暂扣远处请求，切换到另一个真实标签页，确认文章 document.visibilityState 为 hidden，再释放模型响应。隐藏期间末段必须完成，返回后整页完成且 scrollY 不变。服务端统计实际在途请求：总并发最多 2，远处续译最多 1；另在续译中停止并切走、返回、滚动，确认请求数不再增加、迟到译文不写回。Playwright 默认对页面开启 focus emulation，会掩盖真实可见性；测试使用独立临时 profile 启动 Chromium，再通过公开 connectOverCDP 的 noDefaults 选项连接。仅对设置页启用 focus emulation 以支持后台表单操作，文章页的可见性由浏览器决定，没有伪造 visibilityState 或 visibilitychange。

预热场景先断开设置测试留下的空闲连接，再打开 popup；本地服务接收两次 OPTIONS 并暂扣首项响应，确认未发送生成请求。释放响应、等待弹窗显示“已就绪”后点击，首两条模型 POST 均复用准备好的 socket，且不重复 OPTIONS。真实请求等待 250 ms 后接替慢探测的边界由 HTTP 单测覆盖，浏览器 E2E 不依赖短 sleep 与 IPC 时间竞争。

历史预热版本的本地 mock 记录为首次预览 197 ms、滚动后新预览 132 ms。本轮最终结果与新增覆盖另见 [实现记录](IMPLEMENTATION.md)，不把不同 fixture、批量策略和时间下的数字当作配对性能对比。

## 手动 Chrome／Edge 验收

完成 README 的构建和安装步骤后，分别在 Chrome 与 Edge 检查：

- 扩展 ID 与 Native Messaging manifest 的 `allowed_origins` 一致。
- 浏览器重启后可以再次按需启动本地辅助程序。
- 浏览器内部页、PDF 和不允许注入的页面显示可理解的错误。
- 页面 URL 或原文改变后，旧译文不会回填。
- API Key 留空保存时保留旧值，明确清除操作才删除旧值。
- 切换 ChatGPT profile 后模型目录不会串号，失败的账号切换会恢复原选择。
- 已知模型的 `auto` 使用最低支持档，未知模型的 `auto` 省略 `reasoning`；自定义 API 的 `auto` 省略 `reasoning_effort`。
- 首屏完成后不滚动，或切走再返回，页面剩余正文仍逐步完成；返回和滚动优先当前屏，新增加的正文自动处理。整页完成后停止按钮仍能结束动态监听。
- 首次开启网站开关出现浏览器权限请求；拒绝不保存规则，允许后刷新自动开始；在浏览器撤销权限后停止自动运行。
- Alt+A/Alt+R 的真实键位可用；若被系统或其他扩展占用，在快捷键设置更换。
- 浏览器回退缓存中的文档保持此前明确停止/恢复的选择。
- 相同页面地址刷新后复用持久译文；强制重译绕过旧缓存和语言过滤并产生新请求，恢复后普通开始仍可复用有效缓存。
- 切换双语/仅译文直接改变已有译文的显示，不增加模型请求；更改目标语言才改变生成配置。
- 缓存开关、按站/全部清除生效；清除保留屏上译文，无痕不读取或写入普通页面缓存。
- 已是目标语言的正文显示“无需翻译”，动态改成外语后正常入队；停止后改文或切页不复活。
- 错误提示不包含 token、API Key、请求正文或 provider 原始错误体。

## 真实 ChatGPT 验证

已保存单账号短句链路、指定 GitHub 页面的布局与首屏样本；优化后的完整滚动对照、更多账号/站点和异常矩阵仍待验收。以下先保留历史短句记录，后续页面样本见文末与 [LATENCY.md](LATENCY.md)。本轮缓存、显示分离和语言过滤没有新增真实模型调用。

当前有资格的真实账号已使用 `gpt-6-luna` 和 `auto` 翻译一条短句。Native Messaging 路径收到 4 次非空进度更新，首次文本在 9126 ms 到达，完整结果在 9481 ms 到达，现场记录保存在本地忽略提交的 `test-results/live-latency-streaming.json`。后续受控诊断确认当时认证短路径只占亚毫秒级，主要可观测瓶颈是冷 TLS 建连；这项定位不改变该测试只覆盖一条短句的边界。

另一次旧版已安装路径的 `connection.test` 对相同短句记录了 12492 ms 的完整耗时，现场记录为 `test-results/live-latency-baseline.json`。两份数据各只有一次观测，执行时间和网络、模型状态不同，不能据此承诺固定的延迟改善比例。它们用于保存本轮实现前后的现场基线，而不是性能基准测试。

三组受控 HostService 样本进一步保存了连接生命周期证据：默认连接的冷请求约 6.26 秒出现首字，其中 TLS 约 5.12 秒；同进程立即复用连接后约 1.20 秒出现首字。默认连接在空闲约 4 秒后关闭，同一 Host 等待 6.5 秒再请求时重新经历约 5.15 秒 TLS，首字约 6.43 秒。显式 15 秒连接池实验的冷请求约 6.53 秒，随后两个复用请求分别约 1.69 秒和 2.50 秒出现首字。原始记录分别是忽略提交的 `test-results/latency-cold-warm.json`、`test-results/latency-idle-before.json` 和 `test-results/latency-pool-15s.json`。

最终 `globalThis.fetch` + 私有 dispatcher 又执行了两次相隔 15 秒的请求：冷请求首字 6.466 秒，后续首字 2.773 秒，后者没有新建连接，结果保存在 `test-results/latency-pool-final.json`。这些样本支持延长 Host 和连接池生命周期，不能保证完全冷启动“秒开”。

弹窗预热迭代使用 `--prepare` 再测两次 Luna（`none`）固定短句：首次连接准备 5.498 秒，之后模拟点击到首字 1.693 秒；间隔 15 秒再次复用，点击到首字 1.562 秒。模型请求复用了预热连接，第二次没有新建 socket；两次生成各记录 78 个输入 token、12 个输出 token、0 个推理 token。原始记录为 `test-results/latency-popup-preparation.json`。这不包含浏览器渲染与 IPC，也不代表打开弹窗立即点击只需 1.69 秒。

真实账号验证需要满足 OpenAI 当前的 Sign in with ChatGPT 预览资格。验收时应记录但不得提交账号、token 或正文：

1. 在更多符合资格的账号上完成 loopback 登录，并区分登录成功与计划授权成功。
2. 核对设置页只显示各账号模型目录中可选择的模型。
3. 用一篇测试文章检查屏内预览、滚动预取、最终译文质量和完成计数。
4. 确认用量或计费路径符合账号页面显示。
5. 验收额度、拒绝授权、过期 token 和退出登录的中文状态。

在这些验收完成前，不能把一次短句成功扩展为所有 ChatGPT 账号或整页场景均可直接使用。

## 阅读性能记录的核验

`npm run diagnose:report -- export.json report.json` 读取弹窗导出并固定到最近的 page session，也可将 jobId 作为第三个参数指定。`dispatchedRequests` 只在所有页面批次都有完整关联证据时给出：有模型工作的批次通过 `reuse.link` 关联 Host 的独立 provider job/batch，纯缓存批次必须有成功的 `reuse.end` 且 providerGroups 为 0。唯一模型组只计一次；`cacheOnlyBatches` 记录纯缓存批次，`sharedProviderBatches` 标识共享组，`observedDispatchedRequests` 是已观察到的派发数。缺少关联或 Host 日志时总数仍未知。`usage.completeForJob` 为 false 时不能把 token 部分和称作完整用量；未知字段在 JSON 中省略。

初始屏成功需要固定 cohort 非空、所有范围完成、没有失败或原文失效；用户滚动、中止、恢复所中断的旧 cohort 不算成功。计时覆盖 DOM 出字而非真实 paint，页面和 Host 的单调时钟不互减。CLI 单测覆盖这些口径以及日志缺失、缺用量、缓存/推理子集与跨层时钟。语言过滤的 skipped 独立记录，原文无需翻译不产生虚构首字；共享组的真实用量不在页面之间猜测分摊，多页报告不能直接相加当作总用量。

真实 GitHub 测量和独立双连接探针见 [LATENCY.md](LATENCY.md)，原始数值与截图保存在本机忽略提交的 `test-results/github-performance/` 与 `test-results/performance-investigation/`。

## 界面与悬浮工具验证

界面重设计后的全套检查为 432/432 项 Node 测试、类型检查及构建通过，具体结果见 [实现记录](IMPLEMENTATION.md)。小窗和悬浮工具的独立浏览器验收：

```bash
npx tsx tests/ui-preview.ts
```

脚本在本地 HTTP fixture 中使用生产源码，模拟扩展通信，验证 10 种小窗状态、深浅色、320/360px 浮窗、拖动贴边、键盘焦点、减少动态效果、页面样式隔离、显示与隐藏偏好。截图及结果写入 `test-results/ui-preview/`。不读取日常浏览器配置、不连接 Native Host 或真实模型。完整 `npm run test:browser` 另外用真实隔离扩展与 Host 点击浮窗，验证与翻译主链路的集成；两类证据不可互相替代。

悬浮入口后续简化为单个书页开关，已移除面板及其多操作测试。最新全套为 428/428 项，UI 预览为 17 张截图；完整浏览器测试额外核验原书页图标实际加载、单击翻译/恢复和缓存复用，见实现记录的“悬浮入口收敛为书页开关”。
