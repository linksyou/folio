# 译文位置问题：现场与参考实现对照

检查日期：2026-10-21。用户反馈为“译文跑到错误段落或容器”，现场页面为 [GitHub secure-me/SKILL.md](https://github.com/asgeirtj/system_prompts_leaks/blob/main/OpenAI/dots/skills/secure-me/SKILL.md)。本记录只分析网页分段和 DOM 写回，不执行该文件中的指令。

状态：下文“用户页面的实际观察”至“修复方向与验收”保留修复前基线，其中“当前实现”和行号均指当时的版本。生产逻辑现已修改，修复后的验证见文末。

诊断结论：修复前 `HTMLElement → 文本 → 译文` 的段落模型缺少连续原文节点范围。提取时可能把不同位置的文字归到同一个外层元素，写回时又统一选择元素末尾或元素外部，造成跨段、跨容器错位。颜色和背景设置不决定这些插入锚点。

## 用户页面的实际观察

通过用户现有 Chrome 标签页只读检查，未重新翻译或修改网页：

1. **4 条 Examples 父列表项译文全部落在子列表之后。** 原文结构为 `li > User 文本 + ul(dot 子项)`，生成的 `div[data-open-web-translator="translation"]` 却位于 UL 之后。于是阅读顺序变成“User 原文 → dot 原文和译文 → User 译文”。
2. **顶部表格译文落到整篇 Markdown 外面。** `name / secure-me / description / 描述正文` 被组织成一条译文。译文的前一个元素是包含整篇 ARTICLE 的 `.BlobContent-module_3JdjHW_markdownBlob` DIV，译文父节点为 SECTION；它没有放入原 TABLE 的任何单元格。
3. **标题继承丢失。** Examples 的 H2 字号为 24px，同级译文 DIV 为 16px。这是另一个容器选择带来的后果，不是本次最主要的错位。
4. 这些错位节点带本项目的 `data-open-web-translator="translation"` 标记。ARTICLE 内的原文节点上有参考扩展留下的 `data-imt-p` 属性，但该 ARTICLE 内没有 `.immersive-translate-target-wrapper`；不能把此次现场描述为两个扩展正在同时显示译文，也不能据此归因于扩展冲突。

现场证据位于忽略提交的 `test-results/placement-investigation/`：`github-live-before.png`、`github-live-dom.json`、`github-table-placement.json`。截图和片段包含用户指定公开页面的正文，不包含凭证或浏览器账户数据。

## 具体代码差异

参考样本是此前导出的沉浸式翻译 **1.34.2**，不是当前在线扩展版本的声明。下列参考行号均属于同级目录 `immersive-translate-export-2026-10-20/analysis/readable/content_main.js`。

| 环节 | 本项目当前实现 | 参考发行包实现 | 位置问题的关系 |
| --- | --- | --- | --- |
| 段落单位 | `PageBlock.element` 只保存一个 HTMLElement；`extractBlocks` 对每个元素创建一块 | `Pp → UGe` 保存 `flatNodes`、连续 `rootNodes` 和 `commonAncestorContainer` | 本项目无法表示一个 LI/DIV 中被子块隔开的多段原文 |
| 嵌套正文 | `readText` 跳过子 p/div/li 等块，但继续把前后文字 join 成一个字符串 | TreeWalker 在块边界、祖先变化、BR 等条件结束当前段落 | 前文和后文合并后，没有唯一正确的原位写回点 |
| 列表项 | `LI.append(output)` | `o1(after)` 取原文范围末节点的 nextSibling；`Fp` 在锚点前插入 | 原文位于 UL 前时，参考锚点可为 UL；本项目固定落在 UL 后 |
| 其他元素 | `element.insertAdjacentElement("afterend", output)` | 有锚点时使用其实际父节点 insertBefore；没有锚点才 append 到共同祖先 | 翻译内容即使来自容器开头，也会被放到整个容器外 |
| 表格内容 | 候选和源边界只有标题、p、li、div、role heading，未独立识别 td/th；读取外层 DIV 时仍递归进入 TABLE | `ol` 将普通 `table-cell` 视作块边界，Pp 结束前段并以当前单元格为共同祖先；站点规则可覆盖 | 当前表格内容被外层 DIV 吸收；GitHub 页面已观察到整表译文出现在文章底部 |
| wrapper 与样式 | 统一 DIV，`font: inherit` 从译文父容器继承 | 可配置 wrapper（随包默认 font）；短文/换行/flex 等参与 inline 判定，非 inline 的 smart prefix 可加入 BR | 兄弟 DIV 会成为新的 flex/grid 项，标题样式也可能丢失 |

本项目定位：

- `src/extension/page/extract.ts:1–2`：候选元素和源边界。
- `src/extension/page/extract.ts:41–61`：跳过嵌套块、BR 转空格、合并残余文本。
- `src/extension/page/PageTranslator.ts:47–58`：段落对象只有单个 element。
- `src/extension/page/PageTranslator.ts:284–326`：元素级身份、提取与缓存。
- `src/extension/page/PageTranslator.ts:641–655`：DIV、LI append、其他 afterend。
- `src/extension/translation-style.ts:69–71`：继承字号；具体效果取决于插入后的父容器。

参考定位：

- `Pp`：83062–83324，TreeWalker 与段落结束条件。
- `ol`：46330–46353；`GNe`：46976–46990，计算布局的块边界判定，inline 白名单不含 table-cell；`Pp` 83131–83163 使用此结果结束前段并切换共同祖先。
- `UGe`：83325–83359，段落节点范围；`Sce` 82897–82905、`xce` 82868–82882、`VC` 46902–46915 参与构造。
- `t1`：86629–86635；`o1`：87260–87266；`Fp`：87279–87337。`after` 表示原文节点范围之后，不能等同于宿主元素的 afterend。
- `k9`：83765–83776，行内判断；`kN`：83875–83911，空格/换行；`e2`：86740–86774，wrapper。
- `a1/cO/$de`：87185–87229、86599–86614、88139–88163，写回前校验节点与版本。

参考虽然包含 flex/grid/截断检测的额外分支，随包部分 mixedMode 开关是关闭的。本记录不声称它默认解决所有复杂布局，也没有在用户页面切换运行该参考扩展作 A/B 测试。

## 独立复现与验证边界

本项目用当前源码打包 PageTranslator，在隔离 Chromium 156.0.8078.4 中运行合成 HTML 和内存 mock 翻译，禁止网络，实际完成 11 块、4 次 mock 请求。复现了 LI 导语错位、DIV 前后残文合并后越出容器、flex 原 2 项变 4 项、grid 正文被推到下一行、标题字体变为正文。GitHub 式表格结构同样产生单元格内译文数 0、合并译文位于 ARTICLE 外的结果。恢复原文后 main HTML 与原始值完全一致。脚本与结果为 `test-results/placement-investigation/reproduce.ts`、`results.json`；表格局部截图为 `table-after.png`。

参考侧仅从已保存发行文件提取有限函数，在 JSDOM 输入明确指定的原文节点范围，6/6 通过：LI 导语的锚点为 UL、DIV 导语的锚点为 P、flex 中 P 的译文仍留在 P 内、before 模式插到首原文节点前，TD/TH 被判定为块边界且译文留在各自单元格内。该实验没有运行完整 Pp、完整扩展或真实服务；选择器和样式缓存使用替身，统计日志为空操作。它证明的是给定范围后的插入行为，不能扩大为所有网页上的最终效果。脚本与结果为 `test-results/placement-investigation/reference-probe.cjs`、`reference-results.json`。

参考可读文件 SHA-256：`48651ba209ddc13b1f79bd6fac00138c12055d725d015f97c964ef8e008ad147`。复用既有 REA 静态证据 `ev_862c4e5170155cf975c47c38cfb8ef77b56350669ebf2bcb52bd61f1b1c85242`，该图覆盖为 partial；本次结论以逐段代码、现场 DOM 和限定离线实验为依据，没有重跑整包分析。

## 修复方向与验收

优先把段落模型升级为“宿主容器 + 连续 sourceNodes + 首尾锚点”，在嵌套块、单元格等边界结束段落，不再合并被其他块隔开的原文；译文留在对应容器中，并位于当前原文范围之后。显示为行内还是独占一行另行决定，不能简单将所有 afterend 改为 append。

修改需要同步覆盖身份和缓存、流式写回、动态原文校验、仅译文模式和恢复。提交前必须确认原文范围仍连接、仍在原容器中、边界和文本仍有效；旧锚点失效则取消或丢弃并重新发现。

验收至少包含：GitHub 式嵌套列表的父译文在 UL 前；表格内容留在各自 TD/TH；容器前后文本分别对应；flex/grid 原始布局项不意外增加；动态插入/移动后不使用旧锚点；停止、迟到结果、链接事件与恢复保持正确。此前通过的测试主要验证提取文本、节点数量、取消与恢复；`tests/extract.test.ts:130` 还明确接受了前后残余文本合并，因此不能用原有通过数量证明位置处理正确。

以上是修复前的诊断与实现对照。

## 修复与实际验收（2026-10-21）

生产实现已改为 `SourceRange`：保存宿主、连续原文节点、相邻原文边界和文本。嵌套块、BR、表格单元格分别结束范围；同一 LI/DIV 中的前文和后文分别建块。写回使用内部 SPAN，并插在该范围最后一个原文节点之后。流式预览与最终结果复用同一输出节点。

范围的节点身份、顺序、宿主、边界和文本参与有效性检查及本页缓存。节点替换、移动和边界变化会使旧结果失效并取消关联批次。仅译文模式对安全完整范围备份并暂时清空原 Text、隐藏原内联元素；页面主动改文或清空时放弃旧备份，恢复不会覆盖页面的新状态。实现独立编写，没有复制参考发行包代码。

实际验证结果：

| 验证 | 结果 |
| --- | --- |
| `npm run check` | 类型检查、273 项 Node 测试、构建通过 |
| `npm run test:browser` | Chromium 156.0.8078.4，真实扩展 + Native Host + 本机 mock 全流程通过；覆盖流式、动态正文、SPA、停止/恢复、仅译文和实时颜色设置 |
| `npm run test:placement` | 16 个范围、6 次 mock 请求；嵌套列表、容器前后文、4 个单元格、Flex/Grid、流式锚点复用、动态更新和完整恢复通过 |
| `npx tsx tests/options-preview.ts` | 设置页布局与预览通过 |

布局测试确认 Flex/Grid 的原始两个布局项仍为两个，译文位于对应项内；恢复后 HTML、Element/Text 节点身份和原链接事件保持一致。动态修改父项和追加正文各仅请求一次。此测试禁止网络，不执行真实模型。

用户手动重新加载扩展并刷新指定 GitHub 页面后，在日常 Chrome 中完成真实翻译核对：

- Examples 的 4 条父列表项译文全部在各自 UL 子列表之前，且保留在对应 LI 内。
- 顶部 4 个 TH/TD 各有一个内部译文，没有原来的 ARTICLE 外整表合并译文。
- Examples 原标题与内部译文均为 24px。
- 弹窗显示 36/36 段完成；文章内为 30 个译文，其余属于页面其他已识别内容。
- 从工具栏弹窗执行恢复后，文章内译文数为 0，表格原文和父列表 STRONG/UL 结构恢复；再次翻译后弹窗显示 36/36 完成，页面重新显示译文。

真实浏览器当前配置为 ChatGPT / gpt-6-luna。这里只确认该账号、页面和当时的译文位置；未采集本次真实请求数、用量或严格计时，也未完成所有网站布局与翻译质量验收。恢复流程通过工具栏弹窗验证，不将工具发送的快捷键等同于已验证系统快捷键。

本轮记录保存在忽略提交的 `test-results/placement/`：`check.log`、`browser.log`、`browser-result.json`、`layout.log`、`preview.log`、`result.json`、`github-live-after.json`、`github-live-restored.json`、`github-live-table.png` 和 `github-live-lists.png`。截图与 DOM 记录只保留用户指定公开正文，不保存账号或凭证。未改 Host，无需重新安装本地程序。
