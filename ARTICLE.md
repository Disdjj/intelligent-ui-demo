# 拆开 ChatGPT 的 Intelligent UI：一个把「模型生成的界面」跑起来的完整系统

> 本文基于一次真实抓包的逆向分析。所有结论都标注了证据来源（抓包记录 ID 或产物文件），无法确证的地方明确写出「未确认」。
> 分析对象是一次会话：向 ChatGPT 提出「请生成一个复杂的 intelligent-ui 示例」之后，模型返回的整个生成、下发、执行、渲染、回传过程。
>
> **关于引文**：运行时 bundle 是压缩过的，文中的代码片段做了变量名还原（例如 `ke(n)` → `createWorker(name)`），以便阅读；结构与逻辑未改动。涉及凭证、账号、会话与消息标识的地方一律脱敏为 `conv_1` / `msg_1` / `res_1` / `<redacted>`。字节数、条数、次数等统计量保持原值，它们是论据。

---

## 1. 引子：回答不再是一段文字

如果你让 ChatGPT 生成一个「复杂的 intelligent UI 示例」，它会回你一段 Markdown 说明，然后紧接着渲染出一个界面。我们抓到的那次，渲染出来的是一个叫 Acme Billing 的「计费运营台」：

- 顶部是可切换的三个工作区：运营总览 / 计费沙盒 / 交易审计；
- 一排指标卡：模拟净收入、模型成本、贡献毛利率、调用成功率、重复事件抑制率；
- 页面中间的渠道下拉框和时间窗口分段控件是**能用的**——点「30 天」，营收和成本数字会重算；
- 有一个「故障注入」开关，打开后成本曲线上翘、成功率掉到 97.30%、审计列表多出一条异常事件；
- 有一个模拟钱包，点「试扣一轮」会真的扣减余额并把流水写进一张表。

这不是一张截图。界面里的每一个数字都是当场算出来的，每一个按钮都绑着状态。

我们做了一件能验证整条链路的事：把抓到的编译产物里的公式手工重算一遍，和屏幕上渲染出来的数字对照——

```
swings = [-3,2,-1,3,0,4,-2,1,3,-1,2,4]
revenue_i = round((2700 + swings[i]*93) * step * channelFactor)     // step=1, channelFactor=1
cost_i    = round((960  + swings[i]*29) * step * channelFactor)     // incident 关闭
```

7 项求和后 `totalRevenue = 19179`、`totalCost = 6807`，屏幕上正是 **$19,179.00** 和 **$6,807.00**；`100*totalCost/totalRevenue` 得到 35.5%，`(totalRevenue-totalCost)/totalRevenue*100` 得到 64.5%，屏幕上正是「占比 35.5%」和「64.5%」；成功率那格取的是源码里 `incident ? "97.30%" : "99.52%"` 的 else 分支，屏幕上是 99.52%。

**像素级对上了代码。** 这说明我们手里那份 30,932 字节的 JS 就是浏览器真正执行的那一份。接下来的所有分析都建立在这一点上。

---

## 2. 这不是一个「模式」，而是渲染底座

直觉上会以为「智能界面」是个开关：平时是普通聊天，某种情况下切到 UI 模式。**不是。**

证据是本次会话里另一条助手消息——它只是一句说明性文字：

> 我用一个与你之前讨论过的 Acme Billing（化名）相关的场景来演示：做成可交互的计费控制台，而不是静态截图。

这条消息**同样带着** `metadata.model_dil_v2.code`，232 字节：

```js
DIL.render(__dil.jsx(()=>{
  const __dilConstants = DIL.useConstants();
  const __dilModelDataBindings = DIL.useAppData((appData)=>appData.opGenui?.modelDataBindings??{});
  return __dil.jsx("text", null, __dilConstants["0"]);
}, {"key":"body:0"}));
```

配套的 `constants` 就是 `{"0":"我用一个与你之前讨论过的…"}`。

也就是说：**一句纯文本也被编译成一个只渲染一个 `<text>` 节点的 DIL 程序，走完整的编译、下发、沙箱执行、宿主渲染管线。** Markdown 只是这个体系里最平凡的一种 UI。

这个判断改变了后面所有事的性质。它不是一个功能，而是**回答渲染的默认路径**——内部代号 **DIL**（`dil_runner` / `dil_sandbox` / `dil_renderer` / `model_dil_v2`），产品与 API 侧叫 **opGenui / GenUI**。沙箱代码里还有个更早的内部命名痕迹：运行时元素用的是 `Symbol("openai.valdi.dil.runtimeElement")`（`artifacts/dil-runner.js`）。

---

## 3. 整体分层

一句话：**模型写声明式源码，服务端编译成 JS，流式塞给客户端，客户端在沙箱里执行，宿主把执行结果渲染成真实 DOM，交互状态再回到服务端。**

```
【服务端】
  ① 模型输出 DIL 源码
       Markdown 段落 + {@body <JS>} 语句 + JSX-like 组件树
       + {#if}/{:else}/{/if} + {#each … as item}/{/each}

  ② DIL 编译器（流式 · 幂等 · 容错）
       恢复式解析  →  recoveryDiagnostics（带行列号，338 条补丁）
       字符串抽取  →  constants 常量池（108 条）
       代码生成    →  code（30,932 字节 JS，被整体替换 134 次）
       降级文本    →  fallbackMarkdown（687 字符）
       组件识别    →  requiredComponents / genui_components
                          │
                          │  SSE：event: delta
                          │  data: {p:"/message/…", o:"append|replace|add|remove", v:…}
                          ▼
【客户端】
  ③ 补丁应用
       message.content.parts[0]              ← 源码，逐段 append（171 段）
       message.metadata.model_dil_v2.code    ← 编译产物，整体 replace

  ④ DIL Runner（runner-<hash>.js，protocolVersion = 14）
       iframe（无网络 · 不透明 origin）
         └─ Worker（无 DOM）
              ├─ 全局白名单 + 冻结
              ├─ 自研 React-like 渲染器（hooks / effects / keyed children）
              └─ 输出 encoded render tree
                          │
                          ▼
  ⑤ 宿主渲染
       data-d-component="box|row|text|chart|…"
       __resolutionId → 真实宿主组件（30 eager + 283 lazy）
                          │
                          ▼
  ⑥ 交互 → setState → 状态快照
                          │
                          │  POST …/message/<msg>/dil/view_state
                          │  {"updates":[{"scope":"root","state":{…}}]}
                          ▼
               下一轮：genui_state_snapshots 回灌给模型
```

这条链路上每一层都有独立的失败模式，后面会看到工程投入主要花在「让每一层失败都可观测、可降级、可恢复」上。

---

## 4. DSL 设计：为什么是「Markdown + 受控 JSX」

### 4.1 它长什么样

`artifacts/genui-source.dil.md` 是完整源码（23,422 字符）。开头是普通 Markdown，然后是一串顶层语句，最后是组件树：

```text
下面是一个完整的 **Intelligent UI 交互实验台**。它模拟一个 AI 产品的 Billing
Control Center，包含三个可切换的工作区。所有数据均为虚构……

{@body const [tab,setTab] = DIL.useState("overview")}
{@body const [period,setPeriod] = DIL.useState("7")}
{@body const [incident,setIncident] = DIL.useState(false)}
{@body const money = (v) => "$"+Number(v).toLocaleString("en-US",{minimumFractionDigits:2})}
{@body const channelFactor = {all:1,web:0.52,ios:0.31,android:0.17}[channel]}
{@body const trendData = Array.from({length:n},(_,i)=>({ period: …, revenue: …, cost: … }))}
{@body function chargeOnce(){ if(wallet<creditsPerTurn){ setMessage("余额不足…"); return } … }}

<box border radius="2xl" padding={3} gap={4}>
  <row align="center" justify="between" wrap="wrap">
    <box background="surface-secondary" padding={2} radius="lg">
      <icon name="layers-3" size="lg"/>
    </box>
    <badge color={incident?"warning":"success"}>{incident?"演练异常":"系统正常"}</badge>
  </row>

  <segmented-control block size="lg" value={tab} onChange={setTab}
      options={[{"label":"📊 运营总览","value":"overview"}, …]}/>

  {#if tab==="overview"}
    <grid columns={2} gap={2}>
      <grid-item>
        <title size="xl" tabularNums>{money(totalRevenue)}</title>
      </grid-item>
    </grid>
  {:else}
    <box gap={1}>
      <table>
        {#each filteredEvents as item}
          <table-row><table-cell>{item.id}</table-cell></table-row>
        {/each}
      </table>
    </box>
  {/if}

  <button onClick={chargeOnce}><icon name="minus-circle" inline/> 试扣一轮</button>
</box>
```

语法一共就这些：

| 构造 | 写法 | 编译成 |
|---|---|---|
| 顶层语句 | `{@body <JS>}` | 直接内联进渲染函数体 |
| 条件 | `{#if expr}…{:else}…{/if}` | `(__dilSafe(()=>(expr),false)) ? jsx(Fragment,…) : …` |
| 循环 | `{#each arr as item}…{/each}` | `(arr).map(item => __dilSafe(()=>(…), null))` |
| 多子节点分支 | — | 自动包一层 `__dil.jsx(__dil.Fragment, null, …)` |
| 插值 | `{expr}` | 作为 children |
| 字符串属性 | `size="lg"` | `{"size":"lg"}` |
| 表达式属性 | `value={tab}` | `{"value":tab}` |
| 简写布尔 | `block` `inline` `tabularNums` | `{"block":true}` |
| 自闭合 | `<icon name="wallet"/>` | `__dil.jsx("icon",{…})` |
| 宿主组件 | `<MemoryCite />` | `__dil.jsx(MemoryCite,{"__resolutionId":…})` |

本次源码的语法统计：`{@body}` × 40、`{#if}` × 6、`{#each}` × 3、`:else` × 2；组件标签共 265 处，涉及 22 种标签（编译产物里出现 28 种，多出的 `card` / `chart` / `pie-chart` 来自服务端注入的 shim）。

模型可用的运行时 API 只有 6 个：`DIL.useState`、以及 5 个 `GenUI.*` 动作（见 §8.5）。

### 4.2 为什么不让模型直接写 React 或 HTML

这是整套设计里最值得琢磨的一个选择。让模型写 React 组件、或者直接吐 HTML+CSS，工程上更省事——不用写编译器，直接丢进 iframe 就行。他们没有这么做，权衡大概是这几条：

**其一，可静态分析。** 因为 DSL 是结构化的，服务端在流式的每一个中间态上都能回答这些问题：源码里有哪些字符串常量（→ `constants` 池）、有哪些 `useState` 的语义键（→ 状态回执）、引用了哪些宿主组件（→ `requiredComponents`）、哪些字符区间是一个已完成组件（→ `genui_components`）。如果模型直接写 React，这些信息只能靠正则猜或者运行起来才知道，而运行起来就晚了。

**其二，降级文本是免费副产品。** 同一份源码可以同时产出「可执行 JS」和「可读 Markdown」两种形态（`fallbackMarkdown`），这对搜索摘要、无 JS 环境、沙箱崩溃三种场景都直接有用。

**其三，设计系统不可绕过。** DSL 里没有 `style=`，只有 `size="lg"` `color="secondary"` `background="surface-secondary"` 这类语义 token。模型不可能写出一个脱离 ChatGPT 视觉体系、或者会破坏布局的界面——**它在类型系统层面就没有这个能力**。HTML+CSS 则完全做不到这点。

**其四，契约稳定。** 这个 DSL 有版本号（`model_dil_v2`），前端组件库可以独立演进。宿主组件名字的解析走一层间接表（§9.3），所以宿主改名、重构、加版本都不会破坏已经生成的回答。

代价也很清楚：得自己写编译器、自己写渲染器（§7），而且模型得被专门教着写这套语法——那次生成的源码里有 338 条解析器恢复诊断，就是这条路的学费。

---

## 5. 编译器：把「模型输出不合法」当作常态

### 5.1 四个产出

编译结果挂在 `message.metadata.model_dil_v2` 上：

```jsonc
{
  "code": "…30,932 字节 JS…",          // 沙箱执行入口
  "constants": {"0":"…","1":"…", …},   // 字符串池，108 条
  "fallbackMarkdown": "…687 字符…",    // 降级渲染
  "fallbackMarkdownVersion": 1,
  "requiredComponents": ["MemoryCite"],// 需要宿主解析的组件
  "appData": {
    "opGenui": {
      "componentResults": {
        "res_1": {"status":"resolved","state":{},"componentName":"MemoryCite"}
      },
      "modelDataBindings": {}
    }
  }
}
```

产物结构非常固定：**前导 shim + 一个渲染函数**。

```js
function __dilSafe(evaluate, failureValue){ try { return evaluate() } catch { return failureValue } }

// 服务端自动注入的图表兼容层，模型只要写 <chart content={...}> 就行
function DilChartContentPropShim({content=undefined, fallback=null, children}){ … }

DIL.render(__dil.jsx(()=>{
  const __dilConstants = DIL.useConstants();
  const __dilModelDataBindings = DIL.useAppData((appData)=>appData.opGenui?.modelDataBindings??{});
  const [tab,setTab] = DIL.useState("overview",{key:"tab"});
  const swings = __dilSafe(()=>([-3,2,-1,3,0,4,-2,1,3,-1,2,4]), undefined);
  …
  return __dil.jsx("box",{"border":true,"radius":"2xl","padding":3,"gap":4}, …);
}, {"key":"body:40"}));
```

产物统计（`artifacts/genui-compiled.js`）：`__dil.jsx(...)` 323 次、`__dilSafe(...)` 138 次、`__dilConstants["n"]` 108 次、`__dil.Fragment` 5 次、`.map(...)` 4 次、`DIL.useState` 15 次。

### 5.2 `__dilSafe`：几乎免费地把「一处报错」变成「局部降级」

注意两件事：

1. **每一个表达式都被包进 `__dilSafe`**，并且带一个类型正确的兜底值：`filteredEvents.length` 兜 `null`、`{#if}` 条件兜 `false`、数组兜 `undefined`。
2. `{#if}` 的条件判断本身也套了 `__dilSafe(..., false)`。

这意味着模型写出 `undefined.foo` 或者除零得到 `NaN` 时，**炸掉的是那一个节点，不是整个界面**。138 处包裹换来的是「生成代码永远不会因为一个表达式异常而白屏」。这是整个编译策略里性价比最高的一条。

### 5.3 每次整体重编译，而不是增量

本次 SSE 流里，`model_dil_v2/code` 被**整体替换了 134 次**，从 446 字节长到 30,932 字节。客户端从来不做增量编译合并，永远是「拿到当前最新的完整代码」。

原因不难理解：模型输出的中间态大量非法（见下），增量编译要在「半截代码」上维护正确性，代价远高于 30 KB 的带宽。而且 `constants` 池配合这个策略很聪明——**字符串抽到常量池后，流式重编译之间的 diff 更稳定**，变的是值，不是数字索引。

### 5.4 `fallbackMarkdown`：降级路径是一等公民

同一次流里 `fallbackMarkdown` 也被持续维护，最终 687 字符。它承载三种场景：沙箱起不来、环境不支持 JS、被搜索引擎索引。对「生成 UI」这种高失败率的功能，**文本降级不是可选项，是必须项**。

### 5.5 `recoveryDiagnostics`：诊断比产物还多

这是最能说明工程量的一组数字对比：

| 指标 | 次数 |
|---|---|
| `code` 整体替换 | **134** |
| `recoveryDiagnostics` 相关补丁 | **338** |

**服务端花在「记录自己怎么从错误里恢复」上的补丁，比花在编译产物本身上的还多两倍多。** 诊断长这样：

```json
{"code":"unclosed_block","action":"recovered_parse","line":66,"column":9,"directive":"if"}
{"code":"unterminated_tag","line":281,"column":80}
{"code":"unterminated_braced_value","action":"recovered_parse","line":17,"column":5}
```

三类错误对应三类未闭合构造：**未闭合的块**（`{#if}` / `{#each}` 没写 `{/if}`）、**未终止的标签**、**未闭合的花括号**。`action: "recovered_parse"` 是关键——解析器**没有报错终止，而是在残缺输入上继续产出了可运行的代码**。

实现上这大概是一个「未闭合构造栈」：解析到 `{#if}` 就压栈，看到 `{/if}` 就出栈；流结束时栈非空，就按栈里的 `directive`（诊断里的 `"directive":"if"` / `"each"` / `"body"`）补全，并记一条带 `line`/`column` 的诊断。还有一个 `appDirectiveSequenceActive` 标记，用来表示「`{@body}` 指令序列仍在进行中」。

**这就是这套系统的核心设计哲学：模型输出的语法错误不是异常，是正常输入。** 编译器的主要工作不是「正确解析」，而是「在任何残缺状态下都给出一个能跑的东西」。

---

## 6. 流式协议：一种事件类型，一套补丁

### 6.1 三个接口

```
POST /backend-api/f/conversation/prepare    → {"status":"ok","conduit_token":"<redacted>"}
POST /backend-api/f/conversation            (Header: x-conduit-token) → text/event-stream
POST /backend-api/f/conversation/resume     {"conversation_id":"conv_1","offset":17} → text/event-stream
```

`prepare` 返回一个 `conduit_token`（`<redacted>`），作用是**给这次流式请求指派一台网关**——流式不是普通无状态请求，客户端要能带着 token 重连到同一处。

`resume` 的 `offset` 是**事件序号**。本次是 `offset: 17`，说明这条抓包是重连产生的，前 17 个事件不在流里（这也解释了为什么我们重建的源码开头有缺口，而后来的完整快照 `GET /backend-api/conversation/conv_1` 补全了它）。

### 6.2 整个 2.5 MB 的流，只有一种事件

`event:` 字段在整个流里只出现过 `delta` 一个值（207 次）。所有业务语义都在 `data:` 里的补丁对象中：

```json
{"p":"/message/content/parts/0","o":"append","v":" Credits</text>\n      </box>\n …"}
{"p":"/message/metadata/model_dil_v2/code","o":"replace","v":"function __dilSafe(…){…}"}
{"p":"/message/metadata/model_dil_v2/fallbackMarkdown","o":"append","v":"\n\n---"}
{"p":"/message/metadata/genui_components","o":"add","v":[{"type":"charts_widget_v2","tree_range":[58,59],"start_index":8021,"end_index":8039}]}
{"p":"/message/metadata/genui_components/0/end_index","o":"replace","v":8148}
```

这是 JSON Patch 的形态（`p` 是 JSON Pointer，`o` 是 `append`/`add`/`replace`/`remove`），但有两处自己的设计：

**第一，路径里没有 message id。** `/message/...` 里的 `message` 是「当前正在流的消息」这个隐式上下文，靠 `{"o":"add","v":{"message":{…}}}` 切换。好处是路径短、补丁可预期——客户端不需要在每个路径里背一个 36 字节的 UUID。

**第二，`append` 是字符串追加语义**，不是 JSON Patch 标准的数组追加。`content/parts/0` 被 append 了 171 次拼出完整源码；`code` 则是每次 `replace` 整个换掉。**同一个协议下的两种粒度，正好对应两类数据：源码是单调增长的，编译产物是整体重写的。**

本次流统计：delta 207 次；append / replace / add / remove = 295 / 480 / 12 / 10。

非 `delta` 的收尾帧有 `message_marker`（标记 `user_visible_token` 首次出现）、`message_stream_complete`、`conversation_detail_metadata`、`data: [DONE]`，以及 `: ping - <时间>` 心跳。

### 6.3 `genui_components`：边生成边渲染的关键

这是最容易被忽略但最影响体验的一块。除了编译产物，还有一条独立的元数据通道：

```json
[{"type":"charts_widget_v2","tree_range":[58,59],"start_index":8021,"end_index":8039},
 {"type":"charts_widget_v2","tree_range":[65,66],"start_index":8416,"end_index":8466},
 {"type":"charts_widget_v2","tree_range":[166,167],"start_index":14464,"end_index":14574},
 {"type":"memory_cite","tree_range":[306,307],"start_index":23408,"end_index":23422,
  "component_resolution_id":"res_1"}]
```

三个字段各有含义：`start_index`/`end_index` 是**源码里的字符区间**，`tree_range` 是**编译后元素树里的节点下标**，`type` 是组件类型。

关键在于 `end_index` 是**被反复 replace 的**：

```
8021 → 8039 → 8148 → 8209     （第一个组件）
8416 → 8466 → 8557 → 8639 → 8716 → 8723
```

组件边界随流增长。客户端据此判断「这个组件写完了没有、能不能开始渲染」，而不必等整条消息结束。这就是「生成到一半界面上已经出现了第一个图表」的实现方式。

顺带解释了一个命名问题：内建的 `<chart>` 在内部叫 `charts_widget_v2`，说明**图表走的是 widget 通道，而不是内建布局组件通道**。

---

## 7. 运行时：为什么不能用现成的 React

运行时是 `artifacts/dil-runner.js`，184,775 字节，协议版本 14。从 minified bundle 里的模块路径可以把内部结构还原出来：

```text
dil_sandbox/src/
  DILSandboxRuntime        沙箱主入口：render / renderSourceUpdate / updateSource
  DILSandboxGlobals        全局白名单 + 冻结
  DILSandboxRegExp         受控 RegExp（封 constructor 逃逸）
  DILRenderOperations      编码渲染操作
  DILComponentNames        组件名 allowlist
dil_renderer/src/
  DILElement               元素模型（元素 / 文本 / Fragment）
  DILRenderer              渲染协调器
  DILRenderFunctionRuntime 渲染函数运行时（hooks 调度、effects、keyed children）
  DILHookRuntime           Hooks 实现
  DILRuntimeApiImpl        DIL.* 的实现
  DILApiFacade             API 门面 + 加固
  DILSourceEvaluator       编译产物求值
  DILStatePersistence      状态持久化
  DILStateSnapshotCodec    状态快照编解码
  DILSemanticKey           语义键
  DILDictation / DILSpeechSynthesis  语音
```

**这是一个完整重写的 React 内核**——有自己的 `renderVersion`、`invalidationVersion`、`nodeStack`、`committedRootChildren`、`pendingDestroyedNodes`、`keyedComponents`、`namedFunctionIdentities`、`resolvedComponents`。为什么不用 React？

**其一，宿主不是 DOM。** 沙箱里连 `document` 都没有，渲染输出是**编码后的渲染树**（由 `DILRenderOperations` 编码成一组增量 operation 回传），由宿主解码落地成 DOM。`react-dom` 是绑定 DOM 的，用不了；`react-reconciler` 可以自定义 host config，但要拿到「可序列化的增量树」还是得改一大堆。

**其二，整段源码高频替换。** `renderSourceUpdate()` 里有个很说明问题的细节：如果常规路径重渲染产出 `undefined`，它会 `clearRenderedRoot()` 再整个重渲染一次，并把两轮错误合并。这正是为流式重编译准备的——代码每几十到上百毫秒换一次，必须能承受「上一轮渲染到一半，源码整个变了」。

**其三，状态要能被语义键寻址。** `DIL.useState(init, {key})` 的 key 不是调试用的标签，而是**状态在服务端的地址**（§10）。这意味着 hooks 实现必须能被外部按 key 遍历、快照、回填——这已经超出 React 的 hooks 契约了。

**其四，启动预算。** 宿主给整个启动留了 4000ms（`const M=4e3`）。每多一个依赖都要摊到这个预算里。

顺带一提：bundle 里有完整的 `DILDictation`（听写）和 `DILSpeechSynthesis`（朗读）模块。**生成的界面是可以被朗读、也可以用语音操作的**——这解释了为什么 `SpeechSynthesizer` 会出现在常驻宿主组件名单里。

---

## 8. 沙箱与安全

这是整套系统里投入最重的一块。

### 8.1 坐标：一个专门造出来的空白页

```
https://cdn.platform.openai.com/deployments/dil/v14/runner.html
```

注意到**版本号钉在两个地方**：URL 路径里的 `/v14/`，以及所有握手消息里的 `protocolVersion: 14`。这意味着可以按协议版本灰度切到不同部署目录——旧客户端继续用 `/v13/`，新客户端走 `/v14/`。

抓包记录 2116 拿到了这个文档全文，只有 13,236 字节，`<title>DIL Runner</title>`，`<body>` 基本是空的。

### 8.2 CSP 才是主隔离墙

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'sha256-<redacted>' 'self'
             https://cdn.platform.openai.com/assets/dil/ 'unsafe-eval';
  base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none';
  worker-src blob: data:" />
```

逐条看，每条都不是随手写的：

| 指令 | 作用 |
|---|---|
| `default-src 'none'`，且没有 `connect-src` | **沙箱里 `fetch`/XHR/WebSocket/`<img>`/字体全部被浏览器拦死。** 这是「无 IO」的硬保障，比 API 白名单更根本 |
| `script-src` 用 SHA-256 哈希而非 `'unsafe-inline'` | 只允许那一段内联启动探针。CSP3 下存在哈希会使 `'unsafe-inline'` 失效，所以注入进这个文档的任何其他内联脚本都跑不起来 |
| `'unsafe-eval'` | **必须开**，模型代码要求值 |
| `worker-src blob: data:` | 直接暴露了 Worker 的构造方式 |
| `base-uri 'none'` | 文档里 `<script src="/assets/dil/runner-*.js">` 是相对路径，这条防 `<base>` 劫持 |
| `frame-src 'none'` | **嵌套到此为止**，Runner 不能再嵌 iframe |

`'unsafe-eval'` 这一条最值得说。它澄清了一个容易误判的点：**隔离策略不是「禁止动态求值」，而是「允许求值，但求值的地方什么都没有」。** 这也解释了为什么沙箱全局白名单里确实包含 `eval` 和 `Function`——它们不是疏忽，是设计的一部分。安全性由「无网络 + 无 DOM + 不透明 origin」三件事提供。

### 8.3 两层沙箱各挡一半

```
chatgpt.com 宿主页
  └─ <iframe src="…/deployments/dil/v14/runner.html">
       │        ① 无网络的域（CSP default-src 'none'）
       └─ new Worker(blob:…)
            │    ② 无 DOM 的域
            └─ eval(编译产物)
                 ③ 不可信代码
```

**iframe 层：**

- 握手用 `window.parent.postMessage({__oaiDilFrame:true, kind:"ready", protocolVersion:14}, "*", [port2])`，把一条 `MessagePort` 作为 transferable 交给宿主。之后主通道就是这条 port，不走 `window.postMessage` 了。
- 宿主的 `createRunner` 消息校验极严：`__oaiDilFrame === true`、`kind === "createRunner"`、`protocolVersion === 14`、`typeof compiledDil === "string"`、`typeof runnerId === "string"`，五个条件全中才处理。

**iframe 的 origin 是不透明的**，这一点有网络层证据：

| 记录 | 请求 | 关键 header |
|---|---|---|
| 2116 | `runner.html` | `sec-fetch-site: none`、`sec-fetch-dest: document`、**无 `referer`** |
| 2124 | `runner-<hash>.js` | `referer: …/runner.html`、`sec-fetch-site: same-origin`（iframe 内 module 加载） |
| 75 / 2126 | 同一 bundle | **`origin: null`**、`sec-fetch-site: cross-site` |

最后一行是判定依据：**`Origin: null` ⇒ iframe 的 `sandbox` 没有 `allow-same-origin`**。它的 JS 运行在不透明源里——拿不到宿主 DOM、拿不到 `localStorage`、也读不到自己 CDN 域下的任何数据。

（补充一条交叉验证：另一个宿主 chunk 里确实有个通用 iframe 工厂写了 `sandbox="allow-scripts allow-same-origin"`，但那是给「嵌入视图」场景用的，**不是 Runner 的属性**。Runner 侧未直接抓到 `setAttribute("sandbox", …)` 那一行，结论是从 `Origin: null` 反推的。）

**Worker 层：**

```js
const workerBlob = new Blob([
  "(self.URL || self.webkitURL).revokeObjectURL(self.location.href);",   // ← 注意第一行
  workerSource
], { type: "text/javascript;charset=utf-8" });

function createWorker(name){
  try {
    const url = (self.URL||self.webkitURL).createObjectURL(workerBlob);
    if (!url) throw "";
    const w = new Worker(url, {name: name?.name});
    w.addEventListener("error", () => (self.URL||self.webkitURL).revokeObjectURL(url));
    return w;
  } catch {
    return new Worker("data:text/javascript;charset=utf-8," + encodeURIComponent(workerSource));
  }
}
```

三个细节：**Worker 从 `blob:` URL 加载**（所以 CSP 必须放 `worker-src blob:`）；**Worker 代码第一行就把自己的 blob URL 撤销掉**（省句柄，也让它无法被二次加载）；**`data:` 作为回退路径**（所以 CSP 里两个都要列）。

### 8.4 宿主函数怎么「进」沙箱：不是注入，是回调桩

这是整个设计里最巧的一环。

```
宿主主线程                          iframe ⇒ Worker
─────────────────────────────────────────────────────────────
① encode_globals
   把宿主组件/函数编码成
   {__oaiDilGlobalFunction:"<id>"} 占位树
        │
        │  ② createRunner { globals: 占位树 }
        ▼
                                   ③ decode_globals
                                      把占位树还原成
                                      「会 postMessage 回宿主的代理」
                                            │
                                            ▼
                                   ④ unsafe_runner: eval(compiledDil)
                                            │  ⑤ 调用代理
        ◄─────── invokeGlobal {id, args} ───┤
⑥ 真的执行宿主函数
   （GenUI.copy / MemoryCite 渲染 …）
        ─────────── result ────────────────►│
```

判定逻辑（`artifacts/dil-runner.js`）：

```js
function isGlobalFunctionRef(o){
  return o != null && typeof o === "object" && !Array.isArray(o)
      && typeof o.__oaiDilGlobalFunction === "string";
}
function walk(o, invoke){
  const t = n => isGlobalFunctionRef(n) ? (...args) => invoke(n.__oaiDilGlobalFunction, args)
            : Array.isArray(n) ? n.map(t)
            : n != null && typeof n == "object"
                ? Object.fromEntries(Object.entries(n).map(([k,v]) => [k, t(v)]))
                : n;
  return t(o);
}
```

**沙箱里跑的永远只是「桩」。** 真实组件渲染、真实动作（复制、开链接、发起新一轮）都在宿主 origin 执行。`GenUI.copy()` 之所以能在沙箱里「用」，本质上是一次 `invokeGlobal` 往返。

这个设计还顺手解决了一个难题：宿主组件是 React 组件，**它根本不可能被序列化送进 Worker**。用桩就不需要序列化——Worker 只需要知道「有个叫 `MemoryCite` 的东西，props 是这些，需要渲染时喊宿主」。

### 8.5 能力收口：5 个动作，参数校验到语法层

模型能做的一切外呼收敛到 5 个：

```js
GenUI.copy(text)
GenUI.issueNewTurn(query)
GenUI.openEntityDetail(ref | {category, refId})
GenUI.openUrl(url)
GenUI.runPluginTool({tool, arguments})   // async → {status:"success",data} | {status:"error",message}
```

校验严格到有点偏执：`openEntityDetail` 必须**恰好 1 个参数**；`runPluginTool` 必须**恰好 2 个 own key**（`tool` / `arguments`），且参数的原型必须是 `Object.prototype` 或 `null`（挡原型污染）；`copy` 必须 1 个字符串。

`runPluginTool` 是唯一走服务端的能力（`handler:"server"`），客户端只拿到 `{status, message}`，失败时返回的是写死的文案 `"We couldn't confirm the result. Check the plugin before trying again."`——**连错误信息都不让服务端自由发挥**。

### 8.6 72 个启动阶段

Runner bundle 里内嵌了一份跨 realm 共用的操作词汇表，顺序就是真实流水线（实测 72 项）：

```text
host_setup → encode_globals → read_persistence → acquire_frame
 → iframe_create → iframe_load → iframe_resource
  → observer_bootstrap → module_load → module_resource → module_entry → frame_ready
   → manager_create → worker_create → worker_control → worker_module → harden_worker → runner_create
    → worker_ready → decode_globals → decode_persistence → unsafe_runner
     → runtime_construct → seed_runtime → hydrate_state
      → prepare_source → update_source → compile → evaluate → render → render_operations → snapshot_post
       → commit_state → persist_state → flush → flush_render → flush_effects → restore_source
        → react_snapshot → react_materialize → react_commit → react_snapshot_effect
```

外加旁路阶段：`health_probe`、`idle_probe`、`visibility`、`pagehide`/`pageshow`、`freeze`/`resume`、`frame_probe`、`event_loop`、`recovery`、`quarantine`、`dispose` 系列等。

几个名字很说明问题：**`unsafe_runner`**——OpenAI 自己把 Worker 里那段叫「unsafe runner」，命名很诚实；**`harden_worker`** 排在 `runner_create` **之前**，先加固再收代码；**`acquire_frame`** 排在 `iframe_create` 之前，暗示 iframe 可能是被复用/池化的，不是每条消息都新建。

---

## 9. 组件体系

### 9.1 内建布局组件

模型直接用的一套基础积木。本次源码实际用到 22 种，按频次：

| 组件 | 次数 | 组件 | 次数 |
|---|---|---|---|
| `text` | 64 | `button` | 9 |
| `box` | 54 | `table-row` | 5 |
| `row` | 35 | `label` | 4 |
| `icon` | 24 | `grid`/`radio`/`divider`/`slider` | 各 3 |
| `table-cell` | 14 | `table`/`select`/`segmented-control` | 2–3 |
| `title` | 13 | `input`/`checkbox`/`radio-group`/`badge` | 1–2 |
| `grid-item` | 10 | `caption` | 9 |

属性没有一个是 CSS：源码里出现的属性名约 28 个，全是 `size`、`color`、`gap`、`padding`、`radius`、`background`、`align`、`justify`、`wrap`、`weight`、`variant`、`onChange`、`onClick` 这类语义值。宿主把渲染结果标成 `data-d-component="box"`（DIL 内建）或 `data-w-component="chart"`（widget 通道），图表底层是 recharts。

### 9.2 宿主组件：30 个 eager + 283 个 lazy

Runner 里硬编码了两份名单。

**eager（30 个，随 Runner 一起下发）：**

```
OpGenuiResolvedComponentBoundary, AsyncImage, AsyncImageGroup, AsyncVideo,
AutomationPlanSummary, Citation, Cite, CoTToolGroup, CodeBlock, CodeCite,
Entity, FileCite, FileNavList, FlightCard, FlightCarousel, FlightTracker,
FollowUp, FollowUpActionBar, GenImage, LearningVizDil, Link, LinkCard,
MediaFallback, MemoryCite, MessageReaction, NewsCarousel,
PersonalityQuizWidget, ProductCard, SpeechSynthesizer, WritingBlock
```

**lazy（283 个，按需加载）** 覆盖了 ChatGPT 过去两年几乎所有的卡片/小组件：金融（`LedgerNetWorthWidget`、`StockQuoteWidget`、`StockHeatmap`）、体育（`NbaGameboxscoreWidget`、`EplStandingsWidget`）、天气与本地生活（`WeatherWidgetV3`、`LocalBusinessWidget`、`RestaurantMenuWidget`）、学习（`LearningQuiz`、`LearningFlashcards`）、以及约 50 个医疗计算器（`CalculatorSofaScoreWidget`、`CalculatorNihStrokeScaleNihssWidget`…）。

这个分层是有讲究的：eager 那 30 个是**几乎每种回答都可能用到**的东西（引用、代码块、图片、后续追问、记忆引用）；lazy 那 283 个是长尾，按名字动态 import。**否则每次渲染一个纯文本回答都要先下载 283 个组件的定义。**

顺带一提，eager 名单里第一个叫 `OpGenuiResolvedComponentBoundary`——名字本身就是「这里是组件解析边界」的意思。

### 9.3 组件解析：一层间接表撑起解耦

模型写 `<MemoryCite />`，编译成 `__dil.jsx(MemoryCite, {"__resolutionId":"res_1"})`。中间发生了什么：

```js
const placeholder = createDilComponentPlaceholder(name, () => props => {
  const {__resolutionId, ...rest} = props;        // 剥掉内部字段，不让它外泄到真实组件
  let componentName = appData.opGenui?.componentResults?.[__resolutionId]?.componentName;
  if (componentName === undefined) { /* 退化处理：__resolutionId 可能是 JSON 数组，取 [0] */ }
  if (componentName !== name) delete rest.__resolutionId;   // 名称不匹配就不解析
  return jsx(resolved, rest);
});
```

而 `appData.opGenui.componentResults` 的形状由宿主用 zod 校验：`componentResults` 是一个 `record(string, unknown)`，每项要求 `status === "resolved"`；宿主侧缓存键是 `${messageId}:component:${resolutionId}`。

**收益是解耦**：模型不需要知道宿主组件存不存在、叫什么实现、当前版本有没有。解析不到就走 `fallback`（编译产物里每处 `__dilSafe` 的第二参数），或者由 `requiredComponents` 让宿主去准备。同一份生成的回答，可以在组件改名、重构、甚至临时下线之后仍然可用。

代价是多了一次往返（`requiredComponents` 要先声明，宿主解析完回填 `componentResults`，再渲染），所以这个机制主要用在 `MemoryCite` 这类「宿主才知道能不能给」的组件上；高频组件留在 eager 名单里直接可用。

---

## 10. 状态回环

### 10.1 硬证据：15 个键一个不差

编译产物里有 15 个 `useState` 语义键：

```
tab, period, channel, incident, model, turns, retry,
rewards, wallet, ledger, message, search, statusFilter,
riskOnly, selectedAudit
```

紧接着抓到了这条请求（记录 421）：

```
POST /backend-api/conversation/conv_1/message/msg_2/dil/view_state
```

```json
{
  "client_session_id": "…",
  "updates": [{
    "scope": "root",
    "state": {
      "tab":"overview","period":"7","channel":"all","incident":false,
      "model":"balanced","turns":8000,"retry":5,"rewards":15,"wallet":250,
      "ledger":[],"message":"","search":"","statusFilter":"all",
      "riskOnly":false,"selectedAudit":"EVT-1042"
    },
    "client_update_id": "…"
  }]
}
```

响应：`{"status":"success","updated_scopes":0,"message_id":"msg_2","conversation_id":"conv_1"}`

**15 个键与服务端 state 对象的 15 个键完全一致。** 所以 `DIL.useState(initial, {key})` 的 `key` 就是状态在服务端的语义地址——模型给状态起个名字，这个名字就成为跨会话、跨设备恢复状态的索引。

值得注意一个设计细节：源码里模型写的是 `DIL.useState("overview")`，**没有 key**；`{key:"tab"}` 是**编译器补上的**。也就是说模型不需要操心语义键，编译器从变量名推导。

### 10.2 状态的内部实现

`DILStatePersistence` 里，状态槽位的身份是这样算的：

```js
const key = opts?.key;
if (key !== undefined && (typeof key !== "string" || key.length === 0))
  throw new Error("DIL state keys must be nonempty strings.");

const identity = frame.stateIdentity;
const autoSlot = identity?.nextStateSlot;          // 匿名槽位计数器
identity !== undefined && identity.nextStateSlot++;

// 有 key：`${key}\0${ownerKey}`；没 key：退回位置寻址 `${frame.id}:${hookIndex - 1}`
const slotId = identity === undefined
  ? `${frame.id}:${hookIndex - 1}`
  : `${key ?? autoSlot}\0${identity.ownerKey}`;
```

有 key 的按 key 寻址（跨渲染稳定），没 key 的回退到位置寻址（和 React 一样）。另外 `widgetScope(widgetId)` 让每个 widget 有**独立的状态域**，`updateRenderedRootIdentity` 在根身份变化时清空全部分配。

### 10.3 快照不是随便什么 JSON 都能存

这一块比预期严格得多。`DILStateSnapshotCodec` 对状态快照有一整套校验：

```js
const MAX_BYTES = 8 * 1024;          // 序列化后 ≤ 8 KB
const MAX_DEPTH = 8;                 // 嵌套深度 ≤ 8
DIL_ROOT_STATE_MAX_ENTRIES   = 128;  // 根作用域条目上限
DIL_WIDGET_STATE_MAX_ENTRIES = 512;  // widget 作用域条目上限
```

逐项校验规则：拒绝环引用；数字必须是 `Number.isFinite`（挡掉 `NaN`/`Infinity`）；字符串**拒绝孤立代理项**（会在 JSON 往返中损坏）；对象原型必须是 `Object.prototype` 或 `null`；数组必须是原生数组、**且 `Reflect.ownKeys(length)` 恰好等于 `length+1`**（挡掉稀疏数组和数组上的额外属性）；键必须是字符串。序列化之后再检查字节数，最后 `JSON.parse` 往返一次做规范化。

**这是一套「只有确定能安全序列化、能安全还原的状态才允许持久化」的门槛。** 考虑到这些状态的作者是一个语言模型，这道门槛是必要的。

### 10.4 两个方向

| 方向 | 载体 |
|---|---|
| 客户端 → 服务端 | `POST …/dil/view_state` 的 `updates[].state`；下一轮随对话提交的 `genui_state_snapshots` |
| 服务端 → 客户端 | `appData.opGenui.modelDataBindings`，模型用 `DIL.useAppData(a=>a.opGenui.modelDataBindings)` 读 |
| 宿主 → 服务端 | `genui_refresh`（在宿主 chunk 的 zod schema 里） |

`modelDataBindings` 的意图值得单独说：它让**真实数据**（用户真实账单、真实赛程）进到模型生成的 UI 里，而 UI 逻辑仍然由模型写。本次是空的（演示用假数据），但这解释了 `DIL.useAppData` 为什么值得占一行 boilerplate。

`DILStatePersistence` 里还有个 `DILStateSnapshotChangeOrigin { Initial = 0, LocalAction = 1 }`——状态变更带「来源」标记，用来区分「初次水合」和「用户交互」。

> **一个未解的观察**：这条 POST 上报了 15 个值，服务端却回 `updated_scopes: 0`。可能的原因与上面那个 `Initial` 来源有关——这次上报的状态全部是默认值（用户此时还没点过任何控件），而初次水合时服务端已经收到过同一份快照，`setStateSnapshot` 内部也正是靠比较 `serialized` 来跳过无变化更新的。**这只是推断，没有直接证据。**

---

## 11. 工程成熟度：从代码细节看他们踩过哪些坑

这一节是我认为最有意思的部分。功能设计可以抄，但这些细节是被生产事故打出来的。

**诊断默认关闭，只留一根线。** `runner.html` 的内联启动脚本开头就是：

```js
if (new URLSearchParams(location.hash.slice(1)).get("dil-diagnostics") !== "1") {
  addEventListener("error", reportModuleError, true);   // 平时只留这一根线
  return;
}
```

完整打点需要 `#dil-diagnostics=1`。**说明团队清楚诊断本身有成本，不愿让每个用户替它付账。**

**两个文件互相打点，用来定位「卡在哪一环」。** 内联 bootstrap 用 `Object.defineProperty` 暴露一个冻结的 `window.__oaiDilBootstrap`，而 `runner.js` 的**第一行**就是回调它：

```js
try{ window.__oaiDilBootstrap?.moduleEvaluationStarted?.() }catch{}
```

收到文档、bundle 开始求值，是两个不同的时刻。区分开才能判断失败是 CDN 慢、CSP 拦、还是 bundle 抛异常。

**把 `403` 判定为 CSP 拒绝，而不是网络错误。**

```js
const entries = performance.getEntriesByName(event.target.src, "resource");
if (entries.length === 1 && entries[0].responseStatus === 403) modulePolicyDenied = true;
```

并且专门区分了 `timing_unavailable` / `timing_ambiguous` / `timing_missing` 三种「拿不到计时」，以及跨域脚本异常特有的 `stackUnavailable`。代码里还有一条注释解释为什么这是必要的：*"The preload scanner can start this document's module request before the inline bootstrap runs."*——预加载扫描器会在内联脚本执行前就发起 module 请求，所以计时是文档局部的、不完整的。

**用来探测事件循环的探针。** 内联脚本监听 `diagnosticProbe` 消息，用 `setTimeout(…, 0)` 测量回调延迟（`probes++ < 4` 限流）：

```js
const timer = setTimeout(() => record("event_loop", "fired",
  { elapsedMs: now() - startedAtMs, hidden: document.hidden }), 0);
```

**这是在检测 iframe 是否被浏览器节流或冻结。** 页面后台时 `setTimeout` 会被降频，`elapsedMs` 就会暴露出来。一个看起来「死了」的 Runner，可能只是被冻住了。

**首错归因（`first_fault`）。** 72 个阶段会被压缩成一个「最可能的根因」，按优先级匹配：

```js
// 按优先级取第一个命中（此处省略若干 operation 前置判断）
if (operation==="module_load" && reason==="runner_module_exception") return "runner_module_exception";
if (fault || phase==="threw")                                        return "first_fault";
if (reason==="runner_module_script_error")                           return "runner_module_script_error";
if (cspResource==="runner_module" && cspDisposition==="enforce")     return "runner_module_csp_enforced";
if (operation==="quarantine" || operation==="error")                 return operation;
if (operation==="worker_control")                                    return "worker_execution";
…
if (operation==="health_probe")  return phase==="fired" ? "health_probe_expired" : "health_probe";
```

理由是：*最早的那次失败通常才是根因，后面的失败都是它的后果*。还维护了一个「高信号 op:phase 组合」的集合，只有进这个集合的事件才参与归因。

**诊断子系统自带内存预算。** 一组常量（`artifacts/dil-runner.js`；变量名为压缩后的原名，分组与注释为本文所加）：

```js
const D  = 256,   de = 32768;   // 环形缓冲：最多 256 条记录 / 32 KB
const E  = 32;                  // 最多 32 个进行中的 span
const I  = 64,    ce = 65536;   // 最多 64 个进度源 / 全局 64 KB
const ue = 12288, x  = 40;      // 单个进度源 12 KB / 40 个槽位
const le = 8192,  j  = 512;     // 单批序列化 8 KB / 最多转发 512 条
```

缓冲满时**优先淘汰未 pinned 的记录**（`entries.findIndex(o => !o.pinned)`），进度源被挤掉时标记 `coverage: "interrupted"`——宁可明确地说「这段诊断我丢了」，也不静默丢数据。

**generation 三元组防串台。** 每个会话有三层代号：`workerGeneration : sessionGeneration : startupAttempt`，再叠加 `runnerId` / `activeRunnerId` / `documentBootId`。消息对不上就记 `stale_generation` 丢弃。这是为「启动失败重试」和「旧 Runner 迟到消息」准备的——**这类 bug 的症状是「界面莫名渲染出了上一次的内容」，没有 generation 校验几乎无法排查**。

**失败隔离与恢复。** `quarantine` 状态下不再向 Worker 转发事件；但收到新的 `setCompiledDil` 时还有 `recovery` 路径可以救回来。考虑到流式过程中代码每几十毫秒换一次，「因为某个中间态崩了就彻底放弃这个 Runner」是不可接受的。

**健康探测与生命周期。** 启动预算 4000ms；单次健康探测 500ms 超时；最多重试 2 次；`healthCheck` 要求五个代号全部匹配才算 `healthy`；页面隐藏时**暂停**请求计时器而不是让它超时（否则切个标签页回来就全挂了）。bfcache 也照顾到了：`pagehide` 且非 `persisted` 才真正 dispose，`pageshow`/`freeze`/`resume` 全部打点。

**旧会话回收有名额和时间窗**：最多保留 16 个已退休会话、10 秒（`we = 16`, `be = 1e4`），只为接收迟到诊断。超过就释放。

**Worker 自撤销 blob URL**（§8.3）。一个字节的成本，换掉一整类句柄泄漏。

把这些放在一起看，得到的印象是：**这套系统的复杂度主要不是「怎么渲染 UI」，而是「怎么让一个必然经常失败的东西失败得可观测、可降级、可恢复」。**

---

## 12. 关键设计取舍复盘

**① 服务端编译 vs 客户端编译**

选服务端。收益：客户端不用带 DSL 编译器（省一份 bundle 和一份启动预算）；编译器可以随时热更新而不受用户缓存版本影响；不同模型/端可以编译出不同结果。代价：编译产物要占用流式带宽（30 KB 量级，可接受），而且**服务的编译延迟直接进了首字延迟**。从 `code` 被 replace 134 次看，编译器必须够快——它是在流式过程中被反复调用的。

**② 每次都整体重编译 vs 增量编译**

选整体重编译。收益：客户端永远拿到自洽的完整代码，不存在「增量 patch 应用出错导致状态漂移」这类极难查的 bug。代价：134 次全量传输。这个取舍成立的前提是产物足够小（30 KB）且 `constants` 池把易变部分（字符串值）和稳定部分（数字索引）分开了。

**③ 沙箱里没有 DOM vs 直接给 DOM**

选没有 DOM。收益：模型代码拿不到 `document`，XSS、DOM 篡改、直接读宿主数据这条攻击面基本关闭；渲染树是数据，可以被 diff、被序列化、被宿主二次校验。代价：**得自己写一个 React**——hooks 调度、keyed children、effects 清理、状态持久化，一个都不能少（§7）。这是整套系统里最大的一笔自研投入，而且这个投入是被前一个决策逼出来的。

**④ DSL vs 直接写 React/HTML**

选 DSL（§4.2）。核心收益是「可静态分析」和「设计系统不可绕过」。代价是得写编译器，而且得处理模型输出不合法——那 338 条恢复诊断就是账单。

**⑤ 两层沙箱（iframe + Worker）vs 单层**

选两层。这两层挡的不是同一件事：**iframe 挡 IO**（CSP `default-src 'none'` + 不透明 origin，顺带解决存储隔离与「读不到自己域」），**Worker 挡 DOM**（没有 `document`，渲染输出只能是序列化的树）。单靠 Worker 做不到 iframe 那种「默认全禁」的强度——Worker 里全局 `fetch` 是存在的，只能靠白名单列举去堵；单靠 iframe 又拿不到「渲染输出是数据而非 DOM」这个性质。**两层不是冗余，是互补：一个管 IO，一个管执行上下文。**

**⑥ 宿主组件按名字解析 vs 暴露组件引用**

选按名字 + 间接表（§9.3）。收益：模型和宿主组件的版本彻底解耦，宿主重构不破坏历史回答。代价：多一次 `requiredComponents` 往返，且解析失败时的降级路径必须设计好。这解释了为什么高频组件要放 eager——**往返成本对它们不划算。**

---

## 13. 未解之谜

必须说清楚哪些是确证的，哪些是推断的。

**① 系统提示词没抓到——这是最大的缺口。** 教模型写这套 DSL 的指令是服务端注入的。`GET /backend-api/conversation/<id>` 返回的是消息树、不含系统提示；`/conversation/init` 只返回额度与默认模型等元数据。**这个缺口的意义本身就是一个结论**：提示词没走客户端，而是服务端在与模型交互时注入的——这既让它无法被抓包拿到，也意味着它可以随时迭代而不需要客户端更新。

**② 宿主侧创建 iframe 的代码没抓到。** `deployments/dil` 这个字符串在整个抓包里只出现在一条请求的 `referer` 上，说明创建 iframe 的那个 chunk 被缓存了没进抓包窗口。因此 `iframe.setAttribute("sandbox", …)` 的确切字符串**是推断的**（从不透明的 origin 反推为不含 `allow-same-origin`）。取到它的办法是清缓存硬刷新后按 `dil` 过滤网络面板。

**③ `p17` WebSocket 通道只抓到握手。** `wss://ws.chatgpt.com/p17/ws/user/<masked>` 这条路径有 22 条记录，但都只有 HTTP Upgrade 握手，没有帧内容。流式响应里出现过 `resume_with_websockets: true`，说明 SSE 会逐步被 WebSocket 替代，但**替换后的协议长什么样，这次没有证据**。

**④ `genui_state_snapshots` 的非空样本缺失。** 只抓到了首轮提交（值为 `[]`）。所以「上一轮的界面状态具体以什么形式进入模型的上下文」**只能从字段名和 `view_state` 的上报格式推断**，没有直接的对照。

**⑤ `updated_scopes: 0` 含义不明。** 上报成功了但没有任何 scope 被更新。§10.4 给了一个基于 `Initial` 来源的推测，但那是推测。

**⑥ 样本局限。** 只有 1 个账号、1 个模型（`gpt-6-thinking`）、1 次完整生成。三个具体的不确定性：
- 这次生成发生在 `codex_webview` 这个宿主面上（请求头 `x-openai-web-frontend: codex_webview`、`originator: Codex Browser`），**普通 chatgpt.com 网页端是否完全一致，未确认**；
- `model_dil_v2` 里的 `v2` 和 `fallbackMarkdownVersion: 1` 都说明存在更早版本，**无法对比演进过程**；
- 采样到的会话恰好产生了 3 次 `charts_widget_v2` 组件，无法判断组件类型的完整集合。

**⑦ 图标名解析存疑。** 源码里用了 21 个不同的 `<icon name="…">`（`layers-3`、`wallet`、`trending-up`、`receipt-text`…）。但抓到的图标 sprite（834 个 symbol，命名形如 `wallet-light-16`）里**找不到 `wallet` / `cpu` / `layers-3` 这些短名**。所以要么存在一层我们没抓到的短名→真实图标的映射，要么模型确实会写出无效图标名而运行时静默兜底。**未能确认。**

---

## 14. 复刻实践

<!-- 由主 agent 填充 -->
