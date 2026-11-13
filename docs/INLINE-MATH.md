# 行内公式与完整段落（LINK-20）

目标是让读者连续阅读含公式的技术正文。以 2026-11-13 的 [Wikipedia Transformer 页面](https://en.wikipedia.org/wiki/Transformer_(deep_learning)) Embedding 章节为样本，基线 `887c318` 的 `#mwAbo` 是连续两句话、两个行内公式，却被提取为三个范围，生成三份夹在原句中的译文，公式保护项为零。自写最小样本可复现相同问题；原生可见 MathML 对照一直是一范围、两保护项。

本次修复后，这些数学片段在本地转为占位符，前后正文作为完整段落送入既有翻译链路，译文附在原段之后。原文 MathML、SVG、下标、链接及节点保持原样；译文按既有合同恢复公式的纯文本值，不引入数学排版引擎。

## 识别与更新边界

- 辅助包装为 `.mwe-math-mathml-a11y`，仅包含一个直接 MathML 子元素及可选空白；相邻原始兄弟必须是 `mjx-container.MathJax`，或包含直接 `mjx-lazy[data-mjx-lazy]` 子元素的 `mjx-container`。后者是实际网站在懒渲染期间的结构，此时尚无 `MathJax` 类名。兄弟之间允许空白、注释及 Folio 生成节点。
- 包装的父区域与渲染节点仍须可见。只允许读取该配对的数学语义；普通隐藏区域、无对应渲染节点的隐藏 MathML、图片 alt 和 SVG 文字不会因本次适配被纳入。MathML 的 alternate annotation 编码不重复计入公式值。
- `math[display=block]`、明确的块公式类、MathJax 的 `display=true` 或渲染节点的块布局继续作为阅读边界。监听 `display` 属性变化，重新检查现有范围。
- 范围同时保留语义包装与渲染节点，即使公式位于段尾，也在整个公式之后插入译文。仅译文模式仍遵守完整范围与交互安全规则；含链接的原文保持可见。
- 公式文本变化会使旧范围失效；相同掩码译文可以复用，但恢复的是当前段的公式值。懒渲染只更新公式内部节点且语义不变时，保留已完成结果。旧响应、缺失或重复占位符沿用既有拒绝路径。

不把这种明确配对推广为任意 MathJax、KaTeX、SVG 或站点支持；未增加权限、数据路径、PDF、OCR 或视频能力。

## 回归与复现

`tests/fixtures/paired-math.ts` 是按观察到的 DOM 关系自写的样本，不含原站正文、SVG 路径或第三方实现代码。`tests/paired-math.test.ts` 覆盖配对、隐藏/裁剪包装、嵌套、段尾锚点、独立公式和隐藏 canary；原生 MathML 的 CSS 由真实浏览器检查，避免依赖 jsdom 26 不完整的 MathML 样式实现。

`test:browser` 中的 `paired-math` 和 `paired-math-races` 验证：

- 可见 MathML、隐藏配对、裁剪配对、嵌套、注释和懒节点都保持一范围、两保护项；三类独立公式保持前后分离。
- 流式半截占位符不暴露；缺失/重复占位符失败且不缓存，随后重试成功。
- 修改一个公式复用掩码缓存但恢复新值；增删、替换及 inline/display 切换重新协调范围，不重新请求不变段落。
- 原选区、交互链接及源节点恢复；安全段落仅译文模式不留下悬空公式。
- 懒节点在翻译之前、完成之后或进行中变为渲染节点，最终只保留一个结果；进行中改值与不遵守取消的旧响应、停止和恢复均有断言。

```sh
npm ci
npm run check
npm test
FOLIO_BROWSER_CHANNEL=chrome npm run test:browser
npm run test:recovery
FOLIO_BROWSER_CHANNEL=chrome FOLIO_BENCHMARK_ROUNDS=30 npm run benchmark:browser
```

真实扩展检查使用隔离 Chrome for Testing 156、公开页面和模拟 Native 端口，覆盖 Wikipedia、MDN Using Fetch、Python Control Flow、arXiv Mixtral v1、Paul Graham Superlinear Returns 和 HN Dropbox 讨论。网页样本不代表全站支持；受控变更不等同于验证网站所有动态交互。结果、所测提交、截图及性能原始数据随 PR/任务交接保存。真实模型语义质量、网络速度、日常 Native Host 安装与 Edge 尚未验证。

本切片以适配正确性为目标，不承诺提速。按 [性能协议](PERFORMANCE.md) 对照同一机器、Chrome 157、1280×720、固定 12 段与 12/25ms 模拟服务，静止/滚动及 miss/hit 各 30 轮。保留全部失败、取消和 unknown；新公式样本按逻辑段落及公式值验收，不能沿用旧版错误的三范围作为完成目标。
