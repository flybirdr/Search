# 搜索缓存研究：文件变化信息与逐环节缓存可行性

> 目的：回答「能不能拿到文件变化信息，把搜索各环节尽可能缓存（如分行信息），哪些有必要、代价与收益如何」。
> 结论先行：**文件清单缓存已存在且运转良好；真正值得补的是「按 mtime 校验的单文件结果缓存」和「常驻 Worker 池」；分行信息单独缓存不值得做；文件内容缓存不值得做。**

---

## 1. 现状盘点：已经缓存了什么

| 环节 | 现状 | 位置 |
|---|---|---|
| 文件枚举 | ✅ `FileListCache`：内存缓存 + FileSystemWatcher 增量增删 + workspaceState 持久化 + 15s 后台校准 | `src/search/files.ts` |
| glob 过滤 | 每次搜索对缓存清单重新匹配（纯 JS 正则，8 万文件 ~ 几十 ms） | `listWorkspaceFiles` |
| 逐文件 stat | 每次搜索每个文件一次（worker 里 `statSync`，宿主里 `workspace.fs.stat`） | `workerMain.ts` / `controller.ts` |
| 读文件 + 编码判定 | 每次搜索全量重读，**这是最大 I/O 开销** | `readBytes` / `readFileBytes` |
| 内核匹配 | 每次搜索全量重扫，**这是最大 CPU 开销** | `findMatchesBytes` |
| 分行信息 lineStarts | 只对**有命中的文件**构建（惰性，Rust 内核扫 0x0A/0x0D，GB/s 级） | `buildLineStartsBytes` |
| 预览解码 | 只对命中行解码 | `decodeSlice` / `makeItem` |
| Worker / wasm 实例 | 每场搜索新建 N 个 worker → 用完全部 `terminate()`，**每场都付 wasm 实例化成本** | `workerPool.ts` |
| 查询编译 | 每场一次，代价可忽略 | `compileQuery` |

关键观察：**改动后的文件无需事件推送也知道变没变——扫描时反正要 stat，用 mtime+size 对账即可**。这是「拉式校验」，比「推式失效」可靠得多（见 §2）。

---

## 2. 文件变化信息的可用来源

| 来源 | 能拿到什么 | 局限 | 适合做什么 |
|---|---|---|---|
| `FileSystemWatcher.onDidChange` | 文件内容变化事件（现有 watcher **只监听了 create/delete，没监听 change**） | 高频写场景（构建、git checkout）一次能产生数万事件，会撞上已有的 FLOOD_LIMIT 逻辑；watcher 有延迟、可能丢事件 | 文件清单增删（已做）；**不适合**做内容缓存失效 |
| `onDidChangeTextDocument` / `onDidSaveTextDocument` | 已打开文档的每次按键变化 | 只覆盖打开的文件；未打开的文件拿不到 | 文档内搜索路径（当前已直接读 `doc.getText()`，无必要） |
| `workspace.fs.stat` / `statSync`（扫描时对账） | mtimeMs、size、ctime | mtime 粒度（NTFS 100ns、FAT 2s）内同尺寸重写检测不到；扩展宿主关闭期间的外部改动同样靠 stat 发现 | **单文件结果缓存的校验（推荐）** |
| 无公开 API 可用 | — | `findTextInFiles` / TextSearchProvider 是 proposed API，不能消费；VS Code 自身搜索也不缓存文件内容 | — |

**设计取向**：清单维护用推式（watcher，已做），内容/结果有效性用拉式（stat 对账）。拉式的好处是 git checkout、外部编辑、watcher 丢事件统统不会造成脏结果——最坏情况只是退化成重扫一遍，与现状等价。

---

## 3. 逐环节的缓存价值评估

### 3.1 分行信息（lineStarts）—— 单独缓存：不值得 ❌

- 现在只对**命中文件**构建，绝大多数文件根本不碰；Rust 字节扫描是 GB/s 级，20MB 文件约 10–20ms，且只在命中时发生。
- 缓存它的前提是同时缓存**文件字节**（新查询还要拿字节去匹配），而字节缓存被内存判死刑（§3.3）。
- 若做了 §3.4 的结果缓存，行列/预览已随结果一起缓存，lineStarts 作为副产品「自然存在」，无需单独条目。
- 唯一收益场景（同字节、多查询重算位置）不独立成立。

### 3.2 stat 结果缓存 —— 顺带做，几乎零成本 ✅（并入 §3.4）

stat 本身是每次扫描必须的（容量上限判断、流式门槛判断），wram 状态下每次 1–2µs，8 万文件约几百 ms 冷 / 几十 ms 热。单独缓存省不了多少，但它的产出（mtime+size）是结果缓存的校验凭据，随结果缓存一起存即可。

### 3.3 文件内容（字节）缓存 —— 不值得 ❌

- 内存代价：内容多大缓存就多大。几百 MB 的工作区 = 几百 MB 常驻内存，还挤占 wasm 线程内存；VS Code / ripgrep 自己都不做。
- 失效复杂度：watcher 丢事件 → 脏结果，违背「宁可慢不能错」的项目原则。
- 收益仅覆盖「同字节重复搜索」，而该场景被更便宜的结果缓存（§3.4）覆盖。

### 3.4 单文件结果缓存（按查询指纹 + mtime 校验）—— 最值得做 ⭐ P1

**方案**：宿主侧维护一个缓存，key = 文件路径，value = `{ mtimeMs, size, kind, hits, truncated, bytesRead }`（kind 同 worker 的 hit/miss/binary/tooLarge 分类；tooLarge 存 size 即可，是否超限按当次 maxBytes 重判）。另按「查询指纹」分桶，指纹 = `query + mode + caseSensitive + wholeWord + dotAll + perFileLimit + maxBytes`（JSON 串）。

**流程**：搜索开始 → 对每个文件 stat → 指纹命中且 mtime+size 一致 → 直接复用结果，**跳过读文件和内核匹配**；不一致或指纹不命中 → 正常扫描并写入缓存。

- 典型受益场景：① 同条件反复搜索（改了文件后刷新结果：只重扫改动的几个文件）；② count → 全部 的连续动作；③ 反复在结果间导航后再次触发。
- 不受益场景：换查询词（指纹全失效，退化为全量扫描——这是正确的，省不掉）。
- 内存代价：单条命中 ~200B，全局上限 20000 处 ≈ 4MB/指纹；保留最近 3 个指纹 ≈ 12MB 上限。可接受。
- 校验成本：stat 反正要做，**增量校验近乎免费**。
- 落点：worker 路径里 worker 把扫描结果连同 stat 信息一起回报（协议加 `mtimeMs` 字段）；宿主 legacy 路径在 `processFile` 里同样挂接。缓存只放宿主侧一处，worker 生命周期无关。
- 风险与对策：mtime 粒度内的同尺寸重写漏检（极小概率，与主流构建工具同等风险等级；可选加 ctime 比对）；缓存条目数上限 + 指纹 LRU 淘汰防膨胀。

**预估收益**：8 万文件工作区全量扫描约数秒；同指纹重搜只重扫改动文件，预计降到 **50–200ms**（≈ 清单过滤 + 逐文件 stat 的时间）。这是收益/代价比最高的一项。

### 3.5 常驻 Worker 池 —— 第二值得做 ⭐ P2

- 现状：每场搜索 `new Worker` ×N → wasm 实例化 → 编译查询 → 扫描 → **全部 terminate**。wasm 实例化每 worker 数十 ms，整场搜索平白多付 ~30–80ms 启动延迟；查询词逐个调试时每次都付。
- 方案：pool 常驻（惰性创建、空闲不销毁或 5 分钟后回收），每场搜索只广播新 options 重编译查询；abort 语义不变。若做了 §3.4，缓存放宿主侧，worker 改动仅限生命周期。
- 代价：中等重构（生命周期、崩溃后重建、与抢占/取消逻辑的交互）；需要补测试。
- 收益：每场搜索省几十 ms 启动开销 + worker 内可长期保留 OS 文件缓存热度（间接收益）。

### 3.6 文件清单缓存增强 —— 已完成；但过滤环节有 P0 级 bug（见 §6） ⚠️

create/delete 已增量维护、已持久化、已有洪水兜底。清单缓存本身无需再动。
**但 2026-10-20 的实测（82k 文件清单缓存命中后仍花 1917ms）推翻了本文初版「glob 过滤仅几十 ms」的估计**：热点全在过滤循环，根因是 `splitFilters` 不认识 `{a,b}` 内的逗号（§6）。

### 3.7 其它环节

- 查询编译、UTF-16 换算、预览解码：随结果缓存自然覆盖，无独立动作。
- 文档内搜索（当前文档）：走 VS Code 的 TextDocument，本身有缓存，不动。

---

## 4. 建议的落地顺序

| 优先级 | 事项 | 预期收益 | 代价 | 结论 |
|---|---|---|---|---|
| **P0** | splitFilters 花括号 bug 修复 + 排除正则线性化 + 过滤结果缓存（见 §6、§7） | **正确性 bug**：默认 exclude 完全失效；同时消除每次搜索 ~1.9s 的过滤耗时 | 小 | **✅ 已落地（2026-10-20）** |
| P1 | 按 mtime 校验的单文件结果缓存（含 binary/tooLarge 复用） | 同指纹重搜 数秒 → ~百ms | 小（宿主一层 Map + worker 协议加字段 + 测试） | **做** |
| P2 | 常驻 Worker 池 | 每场省 ~30–80ms 启动 | 中（生命周期重构） | **做** |
| P3 | stat 结果并入清单条目 | 微 | 小 | 顺带，不单独立项 |
| — | 分行信息单独缓存 | ≈0 | — | 不做 |
| — | 文件内容缓存 | 有但被 P1 覆盖 | 内存不可接受 | 不做 |
| — | watcher onDidChange 做结果失效 | 同 P1 但不可靠 | 高（洪水、丢事件） | 不做，用 stat 拉式校验替代 |

## 5. 正确性红线（实现时必须守住）

1. 缓存命中必须同时满足：指纹一致 **且** mtime+size 一致；任一不满足即重扫。
2. 缓存只加速，绝不改变结果语义：`truncated`、`binary`、`tooLarge` 分类、perFileLimit 截断行为都要随条目原样复现。
3. 指纹必须包含影响结果集的全部输入：query、mode、三个开关、perFileLimit、maxBytes（maxFileSizeKB / streamThresholdKB 等配置改动要自然失效）。
4. 缓存条目总量与指纹数量设上限（LRU），防止长会话膨胀。
5. 全部沿用现有测试口径：129 用例必须原样通过，另补「mtime 不变命中缓存 / mtime 变化重扫 / 指纹变化重扫」三类用例。

---

## 6. 2026-10-20 补充实测：清单缓存命中后仍 1917ms 的根因（P0，已修复）

实测日志：`cache hit: 82080 files` + `file list in 1917ms cached=yes`。清单缓存明明命中，列表阶段却花了 1.9 秒。定位过程与结论如下（全部数值来自本机 Node 22 基准，82k 条模拟路径 + 日志中的真实过滤条件复现）。

> **状态：本节三项修复已落地**（splitFilters 顶层切分 / glob 线性化 / 过滤结果缓存），另有一个连带的设计修正：`excludeGlob` 默认值改为空，见 §7。修复后同结构基准 82k 过滤 60ms（重复搜索走过滤缓存 ≈0ms），全量 131 用例通过。

### 6.1 根因一（正确性 bug）：`splitFilters` 不认识 `{a,b}` 内的逗号

`splitFilters`（glob.ts）按逗号裸切。默认配置 `flySearch.excludeGlob` 的默认值正是
`**/{node_modules,.git,.svn,dist,out,build,target,.next,coverage}/**`，
于是被切成 **9 个碎片**：

```
'**/{node_modules'  => ^(?:[^/]*/)*\{node_modules$     ← 匹配「字面文件名 {node_modules」，永远不中
'.git'              => (?:^|.*/)\.git$                 ← 只匹配「恰好叫 .git 的文件」
…（中间 6 个同理，全是 basename 精确匹配）
'coverage}/**'      => (?:^|.*/)coverage\}/.*$         ← 匹配「恰好叫 coverage} 的文件」，永远不中
```

后果三层：

1. **这条默认 exclude 语义上完全失效**——`node_modules/a/b.js`、`src/out/x.js`、`dist/lib.js` 全部判「不排除」。目前没炸只是因为：`hasExcludedSegment` 快速路径内置了同一批目录名兜底，且清单来源 `findFiles` 本身尊重 files.exclude / .gitignore。一旦用户目录不在默认名单里（比如自己写了 `**/{src,test}/**` 做 include，或 exclude 写 `**/*.{tmp,bak}`），照样碎。
2. **误伤**：任何深度下「恰好叫 out / build / dist / .git… 的文件」被错误排除（日志里 filtered=285 的主要来源）。
3. **性能**：9 个碎片里有 2 个 `^(?:[^/]*/)*…$` 形态的二次回溯正则，82k 文件 × ~12µs/次 ≈ **1s+**，每次搜索都付——这就是 1917ms 的主体（`hasExcludedSegment` 实测仅 41ms，include `**/*` 正则近乎免费）。

### 6.2 根因二（性能）：`(?:[^/]*/)*` 前缀的回溯对调用形态极其敏感

同一个回溯正则、同一批 82k 条失败判定，V8 下实测差距 70 倍：

| 调用形态 | 耗时 |
|---|---|
| `excludeMatchers.some((re) => re.test(rel))`（现实现的写法） | **1014ms** |
| 内层 for-of 取 `re` 再 `re.test(rel)` | 1097ms |
| 循环不变的常量接收者直接 `re.test(rel)` | 14ms |

即：只要正则接收者来自数组元素/闭包参数（TurboFan 无法按常量特化调用点），回溯正则就是全速回溯；写成常量才吃得到优化。**这意味着靠「改写调用方式」提速不可靠**——随打包结构和 V8 版本漂移。

### 6.3 修复方案（三层，前两层必做）

**A. `splitFilters` 改为只按顶层逗号切**（glob.ts 里现成的 `splitTopLevel` 就是干这个的，拿过来用）。修完后整条 exclude 是 1 个正则而不是 9 个碎片，语义即恢复。这一步同时修复 include 侧同类问题。

**B. 对「`**/` + 纯字面量目录集合 + `/`」形态做线性化改写**。`**/{a,b}/…` 译出的
`^(?:[^/]*/)*(?:a|b)/.*$` 与无锚定线性的 `(?:^|/)(?:a|b)(?=/)` 语义等价（「存在一个完整段 ∈ {a,b} 且后面还有内容」，16 组边界用例两版判定全部一致），实测 82k 全量过滤 **40ms**（any 调用形态下稳定）vs 回溯版最差 1100ms。实现上：形态识别失败就保留现路径，绝不硬翻。
顺带解决 0.1.44 注释里提到的同类隐患——这次是在翻译层消灭 `(?:[^/]*/)*`，而不是依赖调用方写法。

**C. 过滤结果缓存**：`listWorkspaceFiles` 的 accept 结果按 `include + exclude + 清单代数`（FileListCache 每次增量维护/重建时自增一个 generation）键控缓存，重复搜索直接返回上次过滤结果，O(1)。用户过滤器不常变，这一层把 §6.1/6.2 修复后的残余成本（几十 ms）也归零。

### 6.4 修复后的预期

| 阶段 | 现状 | 修复后 |
|---|---|---|
| 清单（缓存命中） | ~0ms | ~0ms |
| 过滤循环（每次搜索） | **~1.9s**（且 exclude 语义错误） | **首次 ~40ms，重复搜索 ~0ms**（B + C） |
| exclude 语义 | 失效 + 误伤 285 个文件 | 正确 |

### 6.5 必补的测试

1. `splitFilters('**/{a,b}/**')` 只出 1 个模式；含转义逗号的行为定档。
2. 线性改写与回溯版的等价性：{a,b} 目录在首/中/尾、同名前缀段（`outx`/`layout`/`source`）、无扩展名目录文件、多过滤器组合。
3. 过滤结果缓存：清单 generation 变化（增/删文件）后必须重算；换 include/exclude 必须重算。
4. 回归现有 129 用例（glob 语义改动影响面大，必须全量过）。

---

## 7. §6 修复的实现记录（2026-10-20 落地）

| 项 | 落点 | 要点 |
|---|---|---|
| A. splitFilters 顶层切分 | `glob.ts` `splitFilters` | 改用现成的 `splitTopLevel`；未配对右括号钳制 depth 不变负 |
| B. 正则线性化 | `glob.ts` `globToRegExp` | body 以「零或多层目录」片段开头且非根锚定时，译为无锚定「行首或斜杠」+ 去片段正文；候选起点集合与原实现等价 |
| C. 过滤结果缓存 | `files.ts` `listWorkspaceFiles` | key = include + exclude + maxFiles + 清单代数（`FileListCache.generation`，在重建/恢复/增量增删/标脏时自增）；点名默认目录的旁路不进缓存 |
| 设计修正 | `package.json` | 默认 `excludeGlob` 改为空（原默认值与内置排除重复，修复 A 后会封死显式点名旁路，见 §6.1 后果 1 的根源） |

新增测试：glob 侧「线性化形态断言 + 16 组边界等价 + splitFilters 大括号/未配对括号」；files 侧「过滤缓存命中/换过滤器重算」（输出面板捕线断言）。注意 `.source` 会转义斜杠，前缀断言要用 `new RegExp(...).source` 同源形式比对。
