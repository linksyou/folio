# 可重复的性能基线

性能记录首先回答读者等了多久，再用同一次任务的阶段解释等待发生在哪里。首段、首屏和整页是三个不同结果；请求返回、DOM 写入和浏览器真正绘制也不能混称。本协议不复用历史单次网络数字作为当前版本的速度承诺。

## 运行与产物

```bash
npm run test:browser
npm run benchmark:browser
npm run benchmark:status
npm run benchmark:dynamic
npm run performance:report -- /path/to/trace.json --output /path/to/report.json
```

`benchmark:browser` 默认 5 轮，使用隔离浏览器与固定合成页面，运行真实 PageTranslator、TranslationReuse 和 IndexedDB，provider 用固定延迟的本地模拟实现。它验证正文调度、显示与缓存路径，不读取本机模型账号，也不能代表真实网络、TLS 或模型生成速度。`benchmark:status` 默认 10 轮，对隔离数据目录中的认证/Host 状态读取计时，不调用模型。具体样本和输出位置以命令输出为准。

`benchmark:dynamic` 默认 30 轮，测 1000 个已是目标语言的长段落中修改一个 Text 节点后的发现与协调耗时，无模型调用；不包含防抖、即时失效校验和绘制。`FOLIO_BENCHMARK_SOURCE` 可指向导出旧版 `src/` 的目录，以相同 fixture 对比。当前对照与适用边界见 [阅读质量迭代](READING-QUALITY.md)。

默认浏览器为 Playwright Chromium；首次需 `npx playwright install chromium`。也可用 `FOLIO_BROWSER_CHANNEL=chrome npm run benchmark:browser` 调用本机 Chrome，测试创建隔离临时 profile，不连接日常浏览器配置。固定浏览器版本和视口再比较；不同浏览器或机器的数据保留为不同实验。

汇总脚本也可直接运行：

```bash
npx tsx scripts/analyze-performance.ts trace.json --output report.json \
  --job PAGE_JOB_ID --scenario article-v1 --source mock --connection unknown --cache miss
```

输入可为一个诊断对象、对象数组，或浏览器基准输出的含 `traces` 数组的完整文件，每个对象表示一轮独立样本。多个 job 存于同一对象时必须指定 `--job`；不要合并不同导出的事件数组。CLI 标签覆盖文件中的 `conditions`，其余未指定标签为 `unknown`。JSON 输出保留逐样本结果与按条件分组的 p50/p95；缺失值为 `null`，不会消失或变成 0。

## 测量定义

| 指标 | 起点与终点 | 成功边界 |
|---|---|---|
| `firstVisible` | PageTranslator `session.start` → 当前视口首次出现非空译文；使用 `dom.firstVisible.sinceSessionMs` | DOM 可见、非空；不是 paint 时间。全是目标语言或全部已有结果时可能没有新译文，保留 unknown。 |
| `clickToFirstVisible` | 用户点击的本机墙钟 → 新译文可见 | 仅接受有效非负墙钟差。时钟倒拨为 unknown；向前调时无法完全由此检测。 |
| `firstScreen` | 首个 `reading.started` 固定的原文范围 → 这些范围全部完成/跳过 | 每个范围成功或明确无需翻译，无失败、待处理、失效；不随译文撑高重选集合。 |
| `reading[].firstVisible/completion` | 本次 scroll 开始 → 新译文可见/固定集合完成 | 保留 `epoch`、已有完成数和 capture delay；滚动合并窗口内已出现的结果使用记录中的原始 duration。下一次滚动中断的样本为 censored。 |
| `wholePage` | `session.start` → 首个 `session.end` | 只指初次静止完成；固定静态 fixture 可解释为整页。动态页面之后新增正文不重写它。空页等待不是 0 ms 成功。 |

统一结果是 `{status: "ok"|"unknown"|"censored", ms: number|null, reason?}`。明确取消、失败、失效属于 censored，可能另带 `observedMs` 表示观察到中断前多久；它不是成功耗时。缺起点、缺终态、空集合、计数不完整属于 unknown。若某项包含失败样本，报告成功样本分位数时必须同时保留 unknown/censored 数。

采用 nearest-rank 分位数，列出 `n`（成功样本数）和 `total`。5 轮的 p95 实际接近最大样本，适合回归提示，不能给稳定尾延迟承诺。首轮保留，不因“看起来慢”剔除；场景扰动只按预先规则标无效，并保留原因。

## 条件必须明确记录

```json
{
  "conditions": {
    "scenarioId": "static-12-paragraphs",
    "source": "mock",
    "connection": "unknown",
    "cache": "miss"
  },
  "page": [],
  "background": [],
  "host": []
}
```

- `source`: `mock`、`live`、`unknown`。模拟数据与实际模型请求绝不合组。
- `connection`: `cold`、`warm`、`unknown`。是否预热、Host 是否重启、连接是否存在需实验控制/显式观测。仅第二轮或请求快不能证明 warm。
- `cache`: `miss`、`hit`、`partial`、`disabled`、`unknown`。指定缓存存储与清空方法；HTTP 连接热不等于译文缓存命中。预热时间应单独记录，不隐藏进“点击后变快”。
- `scenarioId`: 同页内容版本、视口、操作序列和缓存策略保持一致。网页/模型/配置变化时使用新场景，记录代码 commit、浏览器版本、机器和模型设置。诊断文件不写 URL、正文或凭据。

基准的 cold/miss、warm/miss、warm/hit 分开采样；需要模型调用的 live 实验应另行明确授权与固定公开输入。现有自动基线只覆盖 mock，不替代真实模型延迟验收。

## 时钟、关联与完整性

每个 `TimingEvent` 保留 `layer/stage/atMs/jobId/batchId`。`clockId` 标识 JS realm/Host 进程，两个 page TimingLog 共享它；`logId` 区分日志实例，`sequence` 单调递增。每个日志最多 500 条，保留记录最小 sequence 大于 1 时明确标记截断。Host 退出和页面刷新会清空相应内存记录，因此应及时导出；导出当前活动标签页时还需确认 job 匹配。

`atMs` 只在同一 `clockId` 的层内相减。汇总优先使用源端已计算的 duration；Host 阶段若没有 clockId、起终事件不唯一或跨进程重启则为 unknown。不能用 page 的 100 ms 减 Host 的 90000 ms 解释 IPC，也不能从客户端 dispatch→headers 时间推断纯模型计算时间。

页面批次通过后台 `reuse.link` 的 `providerJobId/providerBatchId` 关联实际 provider 组。多个页面批次共享一组只计一次。`reuse.end.success=true` 且 `providerGroups=0` 才证明该页面批次纯缓存完成；Host 日志缺失并不证明零请求。汇总保留 `observedRequests`，只有页面发送、关联和 Host 起终覆盖完整才给 `totalRequests`。模拟浏览器 harness 的 `providerCalls` 单列为 `harnessProviderCalls`，不能当网络请求数。

当前 JSON 汇总不估算 token、费用或请求共享后的用量分摊。生产记录中的返回 token 也不能按每页重复求和。部分可用的首屏计时不因 Host 日志缺失自动作废，但不能同时声称全程网络请求完整。

## 回归判定

先要求固定页面范围完整、无重复译文、停止后无迟到回填、缓存命中时模拟 provider 调用为 0，再比较同条件的首段/首屏/滚动/整页。速度不能靠漏译、跳过失败或少翻段落改善。新增调度策略至少保留相同可译范围与最终文本结果，并检查失败/取消比例没有增加。
