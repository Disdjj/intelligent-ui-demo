# ChatGPT「Intelligent UI」实现分析

> 分析对象：`https://chatgpt.com/c/35349ae3-74a0-42ca-a7be-7d278c9655b1`（标题「生成智能界面示例」）
> 数据来源：本机 Reqable 抓包（1515 条 live capture 记录，其中 589 条 chatgpt.com）
> 分析时间：2026-10-08

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 这是什么 | 内部代号 **DIL**（`dil_runner`、`model_dil_v2`、`dil_sandbox`、`dil_renderer`），产品/API 侧代号 **opGenui / GenUI** |
| 是不是"特殊模式" | **不是**。所有助手回答都被编译成 DIL 程序——连"我用一个与你之前讨论过的 Acme Billing（化名）相关的场景来演示"这种纯文本回答，也带着 `model_dil_v2.code`（232 字节，只渲染一个 `<text>`） |
| 谁写 UI | **模型写声明式 DSL**（Markdown + `{@body}` 语句 + JSX-like 标签），不是写 React、不是写 HTML |
| 谁编译 | **服务端编译**。流式过程中反复整体重编译，把编译产物塞进 `message.metadata.model_dil_v2.code` 发给客户端 |
| 谁执行 | 客户端独立的 **DIL Runner**（`cdn.platform.openai.com/assets/dil/runner-*.js`，协议版本 **14**），在**无 DOM 的 Worker 沙箱**里 `eval` 这段代码 |
| 谁渲染 | 宿主 ChatGPT 前端：把沙箱输出的"编码渲染树"解码，用 `data-d-component="box\|row\|text\|chart..."` 渲染成真实 DOM，并可按名字解析 **30 个 eager + 283 个 lazy 宿主组件** |
| 状态去哪 | `DIL.useState(v,{key})` 的 key 就是**语义键**；客户端把整棵状态树 POST 到 `/backend-api/conversation/{cid}/message/{mid}/dil/view_state`；下一轮通过 `genui_state_snapshots` 回灌给模型 |

一句话概括架构：

> **模型产出源码 → 服务端编译成 JS + 常量池 + 降级 Markdown → SSE 增量下发 → 客户端 Worker 沙箱执行 → 宿主 React 渲染 → 交互状态回传服务端 → 下一轮回灌模型。**

---

## 1. 关键抓包证据索引

| 记录 ID | 内容 | 作用 |
|---|---|---|
| 117 | `POST /backend-api/f/conversation/prepare` | 拿到 `conduit_token`（流式通道令牌） |
| 127 | `POST /backend-api/f/conversation` | 真正的对话提交，请求体含 `genui_state_snapshots`（本轮为空，首轮） |
| 295 | `POST /backend-api/f/conversation/resume` | **2.5 MB SSE 流**，包含完整的编译产物增量下发过程 |
| 1487 | `GET /backend-api/conversation/6ac7316b-...` | 最终完整状态：源码 23,422 字符、编译产物 30,932 字节、常量池 108 条 |
| 421 | `POST .../message/71b81e46-.../dil/view_state` | **状态回传**，把 15 个 `useState` 的值上报 |
| 75 | `GET https://cdn.platform.openai.com/assets/dil/runner-C-vppISG.js` | **DIL 运行时**（184,775 字节），沙箱执行器 |
| 153 | `GET https://chatgpt.com/cdn/assets/889520.*.js` | 宿主侧 GenUI 粘合代码（zod schema、`data-d-component`、`genui_refresh`） |
| 614 | `GET .../icons-*.svg` | 图标 sprite（834 个 symbol），`<icon name>` 的来源 |
| 22/121/269/351 | `wss://ws.chatgpt.com/p17/ws/user/...` | 实时通道（p17），与 SSE 并存 |

所有原始数据已落盘到 [`captures/`](captures)，产物在 [`artifacts/`](artifacts)。

---

## 2. 端到端全景

```
┌──────────────────────────── 服务端 ────────────────────────────┐
│ 1. 模型输出 DIL 源码（Markdown + {@body} + JSX-like 标签）      │
│ 2. DIL 编译器（流式、幂等、容错）                               │
│      ├─ 恢复式解析 recoveryDiagnostics                          │
│      ├─ 字符串抽取 → constants 常量池                            │
│      ├─ 源码 → JS 代码生成（code）                              │
│      ├─ 降级纯文本（fallbackMarkdown）                          │
│      ├─ 组件需求识别（requiredComponents / genui_components）   │
│      └─ 宿主数据绑定（appData.opGenui）                          │
└───────────────────────────────┬────────────────────────────────┘
                                │ SSE: event: delta / data: {p,o,v}  (JSON-Patch 风格)
                                ▼
┌──────────────────────────── 客户端 ────────────────────────────┐
│ 3. 流式补丁应用 → message.content.parts[0] (源码)               │
│                 → message.metadata.model_dil_v2.code (编译产物) │
│ 4. DIL Runner（runner-*.js, protocolVersion=14）                │
│      postMessage {__oaiDilFrame:true,kind:"createRunner",       │
│                   protocolVersion:14, compiledDil, runnerId}    │
│      ├─ Worker 沙箱：冻结全局、白名单化、无 DOM                  │
│      ├─ 自研 React-like 渲染器（hooks/effects/keyed children）   │
│      └─ 输出 encoded render tree（编码后的元素树）              │
│ 5. 宿主渲染：data-d-component 映射到内置组件 + 按名字解析宿主组件 │
│ 6. 交互 → setState → 状态持久化                                  │
└───────────────────────────────┬────────────────────────────────┘
                                │ POST .../dil/view_state
                                │ {"updates":[{"scope":"root","state":{...}}]}
                                ▼
                        回灌：下一轮 genui_state_snapshots
```

---

## 3. 传输层：新流式协议与补丁编码

### 3.1 三个接口

```
POST /backend-api/f/conversation/prepare   → {"status":"ok","conduit_token":"eyJ..."}
POST /backend-api/f/conversation           （Header: x-conduit-token）→ text/event-stream
POST /backend-api/f/conversation/resume    {"conversation_id":"...","offset":17} → text/event-stream
```

`prepare` 返回的 `conduit_token` 是一段 ES256 JWT，payload 里带 `conduit_uuid` / `conduit_location`（内网 IP:端口）/ `cluster`，即"把这次流式请求指派到某台流式网关"。

`resume` 的 `offset` 是**事件序号**，断线重连时从这个序号续传（本次是 `offset: 17`，所以补丁流缺失前 17 个事件）。

请求体里的关键新字段：

```json
{
  "model": "gpt-6-thinking",
  "thinking_effort": "extended",
  "supported_encodings": ["v1"],
  "genui_state_snapshots": [],          // ← 上一轮 UI 状态回灌
  "client_contextual_info": {"app_surface": "codex_browser", "app_name": "chatgpt.com"},
  "browser_context": {"instance_id": "<redacted>"}
}
```

### 3.2 SSE 只有一种事件

整个 2.5 MB 流里 **`event:` 字段只出现过 `delta`**（207 次）。所有业务语义都在 `data:` 的补丁对象里。补丁形如：

```json
{"p":"/message/content/parts/0","o":"append","v":" Credits</text>\n      </box>\n ..."}
{"p":"/message/metadata/model_dil_v2/code","o":"replace","v":"function __dilSafe(...){...}"}
{"p":"/message/metadata/genui_components","o":"add","v":[{"type":"charts_widget_v2","tree_range":[58,59],"start_index":8021,"end_index":8039}]}
{"p":"/message/metadata/model_dil_v2/recoveryDiagnostics/0/line","o":"replace","v":272}
{"p":"/message/metadata/model_dil_v2/fallbackMarkdown","o":"append","v":"\n\n---"}
```

- `p`：JSON Pointer，指向 `/message/...`（`message` 是"当前正在流的消息"这一隐式上下文，路径里不含 message id，靠 `{"o":"add","v":{"message":{...}}}` 切换）
- `o`：`append` / `add` / `replace` / `remove`
- 非 `delta` 的收尾帧：`message_marker`、`message_stream_complete`、`conversation_detail_metadata`、`data: [DONE]`，以及 `: ping - <ISO 时间>` 心跳

**本次流统计：**

| 指标 | 值 |
|---|---|
| delta 事件 | 207 |
| append / replace / add / remove | 295 / 480 / 12 / 10 |
| `model_dil_v2/code` 被整体替换次数 | **134 次**（446 B → 30,932 B） |
| `recoveryDiagnostics` 相关补丁 | 338（最大宗） |
| `constants` 补丁 | 109（最终 108 条） |
| 源码 `content/parts/0` append | 171 段 |

两个设计要点：

1. **编译产物每次整体替换**（`replace`，不是增量）。客户端永远拿到"当前最新的完整代码"，避免增量编译产物不一致。
2. **诊断信息比编译产物还多**（338 vs 134），说明模型输出的 DSL 极不稳定，服务端把"解析器如何从错误中恢复"也当作一等公民暴露出来。

---

## 4. DSL 规范（从源码 + 编译产物反推）

### 4.1 源码长什么样

文件开头就是普通 Markdown，然后是 `{@body}` 语句，最后是组件树：

```text
下面是一个完整的 **Intelligent UI 交互实验台**。它模拟一个 AI 产品的 Billing Control Center……

{@body const [tab,setTab] = DIL.useState("overview")}
{@body const [period,setPeriod] = DIL.useState("7")}
{@body const [incident,setIncident] = DIL.useState(false)}
{@body const money = (v) => "$"+Number(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}
{@body const channelFactor = {all:1,web:0.52,ios:0.31,android:0.17}[channel]}
{@body const trendData = Array.from({length:n},(_,i)=>({...}))}
{@body function chargeOnce(){ if(wallet<creditsPerTurn){ setMessage("余额不足：无法完成本次试扣"); return } ... }}

<box border radius="2xl" padding={3} gap={4}>
  <row align="center" justify="between" wrap="wrap">
    <box background="surface-secondary" padding={2} radius="lg">
      <icon name="layers-3" size="lg"/>
    </box>
    <badge color={incident?"warning":"success"}>{incident?"演练异常":"系统正常"}</badge>
  </row>

  <segmented-control block size="lg" value={tab} onChange={setTab}
      options={[{"label":"📊 运营总览","value":"overview"}, ...]}/>

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

### 4.2 语法清单

| 构造 | 语法 | 编译结果（实证） |
|---|---|---|
| 顶层语句 | `{@body <JS>}` | 直接内联进渲染函数体 |
| 条件 | `{#if expr} … {:else} … {/if}` | `(__dilSafe(()=>(expr),false)) ? __dil.jsx(__dil.Fragment,null,…) : …`，多分支成嵌套三元；**条件本身也套 `__dilSafe`，默认 `false`** |
| 循环 | `{#each arr as item} … {/each}` | `(arr).map(item => __dilSafe(()=>(...), null))` |
| 分支包裹 | 多个子节点 | 自动包一层 `__dil.jsx(__dil.Fragment, null, …)` |
| 插值 | `{expr}` | 作为 children 传入 |
| 字符串属性 | `size="lg"` | `{"size":"lg"}` |
| 表达式属性 | `value={tab}` `onChange={setTab}` | `{"value":tab,"onChange":setTab}` |
| 简写布尔 | `block` / `inline` / `tabularNums` | `{"block":true}` |
| 自闭合 | `<icon name="wallet"/>` | `__dil.jsx("icon",{...})` |
| 宿主组件 | `<MemoryCite />` | `__dil.jsx(MemoryCite,{"__resolutionId":"e2f5a823-…"})` |
| 内联 Markdown | `<text>**粗体**</text>` | 直接进 `__dilConstants`，由 text 组件解释 |

本次源码语法统计：`{@body}` × 40、`{#if}` × 6、`{#each}` × 3、`:else` × 2、组件标签 × 265、内建标签 28 种、属性名 60+ 种。

### 4.3 模型可用的运行时 API（源码里出现的）

```js
DIL.useState(initialValue)            // 15 次
DIL.useState(initialValue, {key})     // 语义键版本（编译器补上）
GenUI.copy(text)                      // 复制到剪贴板
GenUI.issueNewTurn(query)             // 让宿主发起新一轮对话
GenUI.openEntityDetail(ref|{category,refId})
GenUI.openUrl(url)
GenUI.runPluginTool({tool, arguments}) // async → {status:"success",data} | {status:"error",message}
```

后 5 个来自 runner 里的 `createDILModelGenUIFacade`，全部做了严格参数校验（`arguments.length`、类型、原型必须是 `Object.prototype` 或 `null`）。

---

## 5. 编译产物：精确结构

### 5.1 最小样例（纯文本回答，记录 1487 的 `6ba31110` 节点）

源文本：

```text
我用一个与你之前讨论过的 Acme Billing 相关的场景来演示：做成可交互的计费控制台，而不是静态截图。……
```

编译后（232 字节）：

```js
DIL.render(__dil.jsx(()=>{
  const __dilConstants = DIL.useConstants();
  const __dilModelDataBindings = DIL.useAppData((appData)=>appData.opGenui?.modelDataBindings??{});
  return __dil.jsx("text", null, __dilConstants["0"]);
}, {"key":"body:0"}));
```

`constants`：`{"0":"我用一个与你之前讨论过的 …"}`

**这条证据很关键**：即使是一个没有任何交互的纯文本回答，也走完整的 DIL 管线。所以"Intelligent UI"不是插件式开关，而是**回答渲染的默认底座**。

### 5.2 复杂样例（30,932 字节）

整体是「前导 shim + 一个渲染函数」：

```js
// ① 前导 shim：容错求值
function __dilSafe(evaluate, failureValue){ try { return evaluate() } catch { return failureValue } }

// ② 图表组件属性兼容层（服务端自动注入，模型不用写）
function DilChartContentPropShim({content=undefined, fallback=null, children}){
  const __dilConstants = DIL.useConstants();
  const c = __dilSafe(()=>(content ?? {}), undefined);
  const validData = __dilSafe(()=>(Array.isArray(c.data) && c.data.every(...)), undefined);
  const valid = __dilSafe(()=>(["bar","line","pie","scatter"].includes(c.chartType) && validData), undefined);
  ...
  return valid ? __dil.jsx("card",{gap:3}, ...) : fallback;
}

// ③ 用户程序
DIL.render(__dil.jsx(()=>{
  const __dilConstants = DIL.useConstants();
  const __dilModelDataBindings = DIL.useAppData((appData)=>appData.opGenui?.modelDataBindings??{});

  const [tab,setTab] = DIL.useState("overview",{key:"tab"});
  const [period,setPeriod] = DIL.useState("7",{key:"period"});
  ...
  const swings = __dilSafe(()=>([-3,2,-1,3,0,4,-2,1,3,-1,2,4]), undefined);
  const trendData = __dilSafe(()=>(Array.from({length:n},(_,i)=>({...}))), undefined);
  ...
  return __dil.jsx("box",{"border":true,"radius":"2xl","padding":3,"gap":4},
           __dil.jsx("row",{"align":"center","justify":"between","wrap":true},
             __dil.jsx("box",{"background":"surface-secondary",...},
               __dil.jsx("icon",{"name":"layers-3","size":"lg"})),
             __dil.jsx(MemoryCite,{"__resolutionId":__dilConstants["107"]})
           ));
}, {"key":"body:40"}));
```

编译产物统计：

| 指标 | 值 |
|---|---|
| 代码长度 | 30,932 字节 |
| `__dil.jsx(...)` 调用 | 323 |
| `__dilSafe(...)` 包裹 | 138 |
| `__dilConstants["n"]` 引用 | 108 |
| `__dil.Fragment` | 5 |
| `.map(...)` | 4 |
| `DIL.useState` | 15 |
| `DIL.useConstants` / `DIL.useAppData` | 2 / 2 |

### 5.3 编译器的 4 个产出

`message.metadata.model_dil_v2`：

```jsonc
{
  "code": "…30932 字节的 JS…",        // 沙箱执行入口
  "constants": {"0":"…","1":"…"},     // 字符串池，108 条：省带宽 + 便于对比/缓存
  "fallbackMarkdown": "…687 字符…",   // 降级渲染（无 JS / 沙箱失败 / 搜索摘要）
  "fallbackMarkdownVersion": 1,
  "requiredComponents": ["MemoryCite"],// 需要宿主解析的组件
  "appData": {
    "opGenui": {
      "componentResults": {
        "99f2bfbc-1c52-4dd4-a18a-2f35ad4dd765": {"status":"resolved","state":{},"componentName":"MemoryCite"}
      },
      "modelDataBindings": {}
    }
  }
}
```

另有独立通道 `message.metadata.genui_components` —— 把源码字符区间标注成"这是一个 GenUI 组件"，用于流式渐进渲染：

```json
[{"type":"charts_widget_v2","tree_range":[58,59],"start_index":8021,"end_index":8039},
 {"type":"charts_widget_v2","tree_range":[65,66],"start_index":8416,"end_index":8466},
 {"type":"charts_widget_v2","tree_range":[166,167],"start_index":14464,"end_index":14574},
 {"type":"memory_cite","tree_range":[306,307],"start_index":23408,"end_index":23422,
  "component_resolution_id":"99f2bfbc-1c52-4dd4-a18a-2f35ad4dd765"}]
```

注意 `end_index` 在流式过程中被反复 `replace`（8021 → 8039 → 8148 → 8209），说明**组件的边界是随流增长的**，客户端据此判断"这个组件写完没有、能不能开始渲染"。这解释了为什么内建 `<chart>` 在内部叫 `charts_widget_v2`。

### 5.4 服务端容错：`recoveryDiagnostics`

这是最能说明工程量的一块。338 条诊断补丁，记录服务端解析器如何从模型输出的语法错误中恢复：

```json
{"code":"unclosed_block","action":"recovered_parse","line":66,"column":9,"directive":"if"}
{"code":"unterminated_tag","line":281,"column":80}
{"code":"unterminated_braced_value","action":"recovered_parse","line":17,"column":5}
{"directive":"body"} / {"directive":"each"} / {"directive":"if"}
```

即：解析器维护一个**"未闭合构造栈"**，遇到未闭合标签/块/花括号时，用带行号列号的诊断描述，然后**继续编译**（`recovered_parse`），而不是报错终止。所以那 134 次整体重编译里，很多次都是"在当前这个半成品源码上尽力产出可运行代码"。

配套还有 `appDirectiveSequenceActive` 标记，提示"`{@body}` 指令序列仍在进行中"。

---

## 6. 运行时：DIL Runner

产物：`artifacts/dil-runner.js`（184,775 字节，地址 `cdn.platform.openai.com/assets/dil/runner-C-vppISG.js`）

### 6.1 协议常量

```js
const protocolVersion = 14;
const startupBudgetMs = 4000;
const healthProbeTimeoutMs = 500;
const startupAttempts = 2;
```

### 6.2 三层消息命名空间

```js
__oaiDilFrame    // 宿主 ⇄ iframe/runner 帧：{kind:"createRunner"|"disposeRunner", protocolVersion, compiledDil, runnerId}
__oaiDilWorker   // 宿主 ⇄ Worker 控制通道：{kind:"initializeControl"|"healthCheck", protocolVersion}
__oaiDilMessage  // runner ⇄ Worker 业务通道：{kind:"command"|"response"|"event"|"failure", id, command|event, data}
__oaiDilGlobalFunction  // 沙箱内注册的全局函数（宿主可 invokeGlobal）
__oaiDilWebElementProps // 传给宿主组件的元素属性
```

消息 kind 全集（从代码常量提取）：
`initializeControl`、`createRunner`、`disposeRunner`、`ack`、`ready`、`healthy`、`healthCheck`、`executionStarted`、`executionFinished`、`command`、`response`、`event`、`failure`、`diagnostic`、`diagnosticSnapshot`、`lifecycle`、`snapshot`、`messengerEvent`。

命令全集（`ge` 集合）：
`initialize`、`__dil_initialize`、`createRunner`、`disposeRunner`、`initializeControl`、`registerMessengerTransport`、`unregisterMessengerTransport`、**`setCompiledDil`**、**`setData`**、**`setStateSnapshot`**、`trigger`、`invokeGlobal`、`invokeMessengerCommand`、`snapshot`、`lifecycle`、`messengerEvent`。

### 6.3 双通道 + Worker 沙箱

> 完整的承载形式（iframe 文档、CSP、握手、Worker 构造）见 **[RUNNER-SANDBOX.md](RUNNER-SANDBOX.md)**，本节只讲协议。

- Worker 通过 `postMessage({__oaiDilWorker:true, kind:"initializeControl", protocolVersion}, [controlPort])` 把一条 `MessagePort` 交回宿主，形成**控制通道**（只走健康检查/诊断）。
- 业务指令走另一个 port；宿主转发时需要做 **generation 校验**（`workerGeneration` / `sessionGeneration` / `startupAttempt` / `runnerId` / `activeRunnerId` / `documentBootId`），防止旧 runner 的迟到消息污染新会话。
- 有完整的 **健康探测**：`health_probe` 记录 `sent/received/ignored`，带"探测预算耗尽"（`target_probe_budget_exhausted`）与超时；页面隐藏时暂停计时器（`request_timer paused hidden`）。

这套复杂度的动机只有一个：**生成代码是不可信的、会崩的、会死循环的**，所以必须能隔离、能超时、能重启、能诊断。

### 6.4 沙箱内部：一个自研的 React-like 渲染器

从 minified bundle 里的模块路径可以还原完整模块图：

```text
dil_sandbox/src/
  DILSandboxRuntime        沙箱主入口：render / renderSourceUpdate / updateSource
  DILSandboxGlobals        全局白名单 + 冻结
  DILSandboxRegExp         受控 RegExp（防原型逃逸）
  DILRenderOperations      编码渲染操作
  DILComponentNames        组件名 allowlist
  WeakRef                  弱引用 shim

dil_renderer/src/
  DILElement               元素模型（kind: 元素 / 文本 / Fragment …）
  DILRenderer              渲染协调器（createRenderContext / commitStateSnapshot）
  DILRenderFunctionRuntime 渲染函数运行时（hooks 调度、effects、keyed children）
  DILHookRuntime           Hooks 实现（useState / 自定义 hook 槽位）
  DILRuntimeApiImpl        DIL.* API 实现
  DILApiFacade             API 门面 + 加固（hardenApiFacade / freezeObjectGraph / bindDILClientAction）
  DILSourceEvaluator       编译产物求值
  DILStatePersistence      状态持久化
  DILStateSnapshotCodec    状态快照编解码
  DILSemanticKey           语义键（getSinglePotentialHostRootIndex）
  DILHtmlViewMessenger(+TransportRegistry/State)  HTML 视图消息传递
  DILDictation / DILSpeechSynthesis / DILSpeechOwner / DILDictationOwner  语音
```

值得注意：
- 这是个**完整重写的 React 内核**（`nextFrameId`、`nodeStack`、`committedRootChildren`、`pendingDestroyedNodes`、`renderVersion`、`invalidationVersion`、`keyedComponents`、`namedFunctionIdentities`、`resolvedComponents`），因为它必须能被"整段源码替换"后仍然做最小的 DOM 级 diff。
- `renderSourceUpdate()` 里有个细节：如果常规重渲染产出 `undefined`，会 `clearRenderedRoot()` 再重试一次，并把两轮错误合并。这正是为了应对**流式重编译**（代码每 ~120ms 换一次）。
- 有 **Dictation/SpeechSynthesis** 模块 —— 生成的 UI 可以被朗读、也可以用语音操控。
- 渲染输出不是 DOM，而是 **`encoded` 渲染树**（`DILStateSnapshotCodec` 编码），交给宿主解码渲染。沙箱里连 `document` 都没有。

---

## 7. 组件体系

### 7.1 内建布局组件（模型可以随便用）

从本次源码的实际使用统计：

| 组件 | 次数 | 组件 | 次数 |
|---|---|---|---|
| `text` | 64 | `button` | 9 |
| `box` | 54 | `table-row` | 5 |
| `row` | 35 | `label` | 4 |
| `icon` | 24 | `grid` / `radio` / `divider` / `slider` | 3 各 |
| `table-cell` | 14 | `table` / `select` / `segmented-control` | 2–3 |
| `title` | 13 | `input` / `checkbox` / `radio-group` / `badge` / `pie-chart` | 1–2 |
| `grid-item` | 10 | `caption` | 9 |

（编译产物里另有 `card`、`chart`、`Fragment`，来自 shim 与嵌套。）

宿主用 DOM 属性标记它们：`data-d-component="chart"`（DIL 内建）/ `data-w-component="chart"`（widget 版本），图表底层是 **recharts**（证据：宿主 chunk 里 `document.querySelectorAll('.recharts-legend-wrapper > * > *')` 用于"复制图表为图片"）。

### 7.2 宿主组件白名单：30 eager + 283 lazy

runner 里硬编码了两份名单（`DIL_COMPONENT_NAMES`）。**eager（30 个，常驻）**：

```
OpGenuiResolvedComponentBoundary, AsyncImage, AsyncImageGroup, AsyncVideo,
AutomationPlanSummary, Citation, Cite, CoTToolGroup, CodeBlock, CodeCite,
Entity, FileCite, FileNavList, FlightCard, FlightCarousel, FlightTracker,
FollowUp, FollowUpActionBar, GenImage, LearningVizDil, Link, LinkCard,
MediaFallback, MemoryCite, MessageReaction, NewsCarousel,
PersonalityQuizWidget, ProductCard, SpeechSynthesizer, WritingBlock
```

**lazy（283 个，按需加载）** 覆盖了几乎所有 ChatGPT 既有卡片/小组件（节选）：

- 金融：`LedgerNetWorthWidget`、`LedgerSpendByCategoryWidget`、`LedgerTransactionDetail`、`StockQuoteWidget`、`StockHeatmap`、`CurrencyConverterV2Widget`…
- 体育：`NbaGameBoxscoreWidget`、`EplStandingsWidget`、`F1StandingsWidget`、`WnbaScheduleWidget`…
- 天气/新闻/地图：`WeatherWidgetV3`、`NewsArticleWidget`、`LocalBusinessWidget`、`RestaurantMenuWidget`…
- 学习：`LearningQuiz`、`LearningFlashcards`、`LearningVoiceModeLauncherCard`、`WordCardWidget`…
- 医疗计算器：`CalculatorWellsScoreForPulmonaryEmbolismWidget`、`CalculatorSofaScoreWidget`、`CalculatorNihStrokeScaleNihssWidget`…（约 50 个）
- 通用：`CalendarEventsWidget`、`ChecklistWidget`、`DigitalTimerWidget`、`UnitConverterWidget`、`CalculatorWidget`、`EntityCard`、`Rating`、`StockChart`…

这份名单本身就是产品情报：**ChatGPT 把过去两年做过的所有卡片组件都统一收编成了 GenUI 的"宿主组件库"**。

### 7.3 组件解析流程（宿主 chunk 里的 zod schema）

```js
// 宿主校验 appData 形状
p.object({
  appData: p.object({
    opGenui: p.object({
      componentResults: p.record(p.string(), p.unknown())
    })
  })
})
p.object({ status: p.literal("resolved") })

// 缓存键：component 用 resolutionId，引用用 refIndex
`${messageId}:component:${resolutionId}`  |  `${messageId}:ref:${refIndex}`
```

runner 侧的解析：

```js
const placeholder = createDilComponentPlaceholder(name, () => props => {
  const {__resolutionId, ...rest} = props;           // 剥掉内部字段
  let componentName = appData.opGenui?.componentResults?.[__resolutionId]?.componentName;
  if (componentName === undefined) { /* 退化：__resolutionId 可能是 JSON 数组，取 [0] */ }
  if (componentName !== name) delete rest.__resolutionId; // 名称不匹配则不解析
  return jsx(resolved, rest);
});
```

即：模型写 `<MemoryCite />`，编译器生成 `__resolutionId`，宿主把"这个 id 解析到了哪个真实组件"通过 `appData.opGenui.componentResults` 回填。**模型不需要知道组件是否存在、叫什么实现**，解析失败时有 `fallback` 与 `requiredComponents` 兜底。

---

## 8. 状态：语义键 + 回传 + 回灌

### 8.1 实证：`useState` key 与 `view_state` 一一对应

编译产物里的 15 个状态键：

```
tab, period, channel, incident, model, turns, retry,
rewards, wallet, ledger, message, search, statusFilter,
riskOnly, selectedAudit
```

`POST /backend-api/conversation/6ac7316b-…/message/71b81e46-…/dil/view_state` 的请求体：

```json
{
  "client_session_id": "9d099407-920e-4019-a593-cf9de14d28a1",
  "updates": [{
    "scope": "root",
    "state": {
      "tab":"overview","period":"7","channel":"all","incident":false,
      "model":"balanced","turns":8000,"retry":5,"rewards":15,"wallet":250,
      "ledger":[],"message":"","search":"","statusFilter":"all",
      "riskOnly":false,"selectedAudit":"EVT-1042"
    },
    "client_update_id": "df05e33c-8559-4ca1-addc-4b116d694f3c"
  }]
}
```

响应：`{"status":"success","updated_scopes":0,"message_id":"…","conversation_id":"…"}`

**15 个键完全一致**，一个不差。所以 `DIL.useState(initial, {key})` 的 `key` 就是状态在服务端的**语义地址**；`scope` 支持多作用域（`root` 之外还应有组件级作用域），`client_update_id` 用于幂等/去重。

### 8.2 两个方向的通道

| 方向 | 载体 | 字段 |
|---|---|---|
| 客户端 → 服务端 | `POST .../dil/view_state` | `updates[].state`（实时）+ 下一轮 `genui_state_snapshots`（随对话提交） |
| 服务端 → 模型 | 对话上下文 | `genui_state_snapshots` |
| 服务端 → 客户端 | `appData.opGenui.modelDataBindings` | 模型可用 `DIL.useAppData(a=>a.opGenui.modelDataBindings)` 读取 |
| 宿主 → 服务端 | `genui_refresh`（host chunk 中的 schema） | `p.record(p.string(), p.unknown())` |

`modelDataBindings` 的用途：把**真实数据**（比如用户真实账单、真实赛程）绑定进生成的 UI，而 UI 逻辑仍是模型写的；本次为空（演示用假数据）。

---

## 9. 安全模型

生成代码在客户端执行，安全设计相当扎实：

1. **无 DOM 环境**：跑在 Worker 里，没有 `document`/`window`；渲染结果是编码后的树，由宿主翻译成 DOM。
2. **全局白名单**（`getDILSandboxAllowedGlobalNames`）：允许 `Array/Object/JSON/Math/Date/Map/Set/Proxy/Reflect/RegExp/Intl/TextEncoder/Promise/WeakMap/WeakRef/SharedArrayBuffer/Atomics/...`，外加组件名。**没有 `fetch`、没有 `XMLHttpRequest`、没有 `WebSocket`、没有 `localStorage`、没有 `import`**。
   - 注意：白名单里**确实包含 `eval` 和 `Function`** —— 因为 `DILSourceEvaluator` 必须求值编译产物，且 `Proxy`/`Reflect` 也在，沙箱的隔离主要靠"没有 IO + 独立 realm"，而不是禁止动态求值。
3. **全局加固**：`lockDownSandboxGlobal`（冻结 + 语义化清空）、`hardenSandboxGlobal`（`freezeObjectGraph` 深冻结）、`DILSandboxRegExp`（重造 `RegExp` 构造器，封住 `constructor` 逃逸路径）。
4. **API 门面加固**：`hardenApiFacade` 把 facade 对象原型设为 `null`、递归冻结；沙箱传给宿主的回调会被 `wrapCallback` 包一层；`renderedPropNames` 跟踪哪些 prop 被真的渲染过。
5. **GenUI 动作校验**：`GenUI.openEntityDetail` 必须恰好 1 个参数；`GenUI.runPluginTool` 必须恰好 2 个 own key（`tool`/`arguments`），且参数必须是 `Object.prototype` 或 `null` 原型的纯对象（防原型污染）；`GenUI.copy` 必须 1 个字符串。
6. **能力收口**：模型能做的一切外呼都收敛到 5 个 GenUI 动作；`runPluginTool` 走 `handler:"server"`，由服务端代理，客户端只拿到 `{status, message}`。
7. **生命周期隔离**：generation 校验 + `disposeRunner` + 超时回收，防止旧代码长期驻留。

---

## 10. 设计要点总结（为什么这么做）

| 设计 | 解决的问题 |
|---|---|
| 服务端编译（而不是客户端） | 客户端不用带 DSL 编译器；编译逻辑可以随时热更新；可对不同的模型/端做不同编译 |
| 每次流式**整体重编译**而非增量 | 生成代码的中间态大量非法，增量编译的正确性代价远高于带宽代价（30 KB 而已） |
| 字符串抽到 `constants` | 压缩 + 让"流式重编译"的 diff 更稳定（数字索引不变，只有值变） |
| `fallbackMarkdown` | 沙箱挂了 / 无 JS / 搜索结果里，仍能降级为可读文本；本次 687 字符，是源码的合理摘要 |
| `recoveryDiagnostics` | 把"模型输出不合法"当作**正常输入**处理，而不是异常；带行列号的恢复记录可回传训练/调试 |
| `genui_components` + `end_index` 流式增长 | 让 UI 能"边生成边渲染"，不需要等整条消息结束 |
| Worker 沙箱 + 自研 React 内核 | 不可信代码隔离；把 DOM diff 的复杂度从宿主挪进沙箱 |
| 状态回传 + 回灌 | 生成 UI 有了"记忆"，可以跨设备/跨轮次延续；模型能针对用户当前看到的界面继续回答 |
| `requiredComponents` + `appData.componentResults` | 让"模型写的组件名"与"宿主真实组件"解耦，同名/缺失/版本差异都能兜住 |

---

## 11. 如果你想复刻：最小可行路线

按依赖顺序，5 层：

1. **DSL 层**：实现 Markdown 段落 + `{@body}` + 受控 JSX 子集 + `{#if}/{#each}` 的解析器。
   - 关键点：**容错恢复**（未闭合块/标签/花括号），本次抓包里 338 条诊断就是这一层的成本。
   - 建议用「维护未闭合构造栈 + 逐段产出部分 AST」的方式，而不是一次性 parse。
2. **代码生成层**：AST → JS，用与 ChatGPT 相同的三件套：
   - 字符串池（`constants`）
   - 逐表达式 `__dilSafe(() => expr, fallback)`（**这一条几乎免费地把"一处报错炸掉整个 UI"变成"局部降级"**）
   - 渲染入口 `render(jsx(bodyFn, {key}))`
3. **沙箱执行层**：Worker + 全局白名单 + 冻结；自研或用 Preact/React 的 `react-reconciler` 自定义 host config，输出**可序列化的渲染树**而不是 DOM。
4. **宿主渲染层**：树 → 真实组件，用 `data-*-component` 打标；组件解析走 `resolutionId → 真实组件` 的间接表。
5. **状态与回传层**：`useState(init, {key})` + 节流 POST `view_state`；下一轮把快照塞回对话上下文。

不必抄的部分：283 个宿主组件、双 MessagePort 控制通道、语音模块。前 4 层大约就是"能用"的门槛。

一个可以直接抄的最小编译输出模板：

```js
function __safe(f, fallback){ try { return f() } catch { return fallback } }

render(jsx(() => {
  const C = useConstants();
  const [tab, setTab] = useState("overview", { key: "tab" });
  const n = __safe(() => (period === "7" ? 7 : 30), 7);
  return jsx("box", { gap: 2 },
    jsx("segmented-control", { value: tab, onChange: setTab, options: C["0"] }),
    __safe(() => jsx("text", null, C["1"], tab), null)
  );
}, { key: "body:0" }));
```

---

## 12. 未解与存疑

1. **系统提示词没抓到**。教模型写这套 DSL 的指令是服务端注入的，`/backend-api/conversation/{id}` 与 `/conversation/init` 都不返回它。这是本次分析最大的缺口。
2. ~~**沙箱的具体承载形式**未 100% 确认。~~ **已解决，见 [RUNNER-SANDBOX.md](RUNNER-SANDBOX.md)**。承载形式确认为两级：宿主 → `https://cdn.platform.openai.com/deployments/dil/v14/runner.html`（跨域 iframe，不透明 origin，CSP `default-src 'none'`）→ `new Worker(blob:)`（无 DOM）。唯一残留缺口是宿主侧 `iframe.setAttribute("sandbox", …)` 那一行代码没抓到（属性字符串可由 `Origin: null` 反推为**不含** `allow-same-origin`）。
3. **`p17` WebSocket 通道**只抓到握手（`wss://ws.chatgpt.com/p17/ws/user/<uid>`，22 条），没有帧内容。`resume_with_websockets: true` 说明 SSE 会逐步被 WS 替代。
4. **`genui_state_snapshots` 非空样本缺失**。本次只抓到首轮提交（`[]`），第二轮请求没进抓包窗口，所以"状态如何具体回灌给模型"只能从字段名推断。
5. **样本局限**：只有 1 个账号、1 个模型（`gpt-6-thinking`）、1 次完整生成。`fallbackMarkdownVersion: 1`、`model_dil_v2` 里的 `v2` 都提示存在更早版本，无法对比演进。
6. **`updated_scopes: 0`** 的含义不明：状态明明上报成功，但没有 scope 被更新。可能与"该消息未达到持久化门槛"或"状态与上次相同"有关。
7. `<icon name="wallet"/>` 这类图标名在 sprite（834 个 symbol，命名形如 `wallet-light-16`）里**并非全部存在**，所以要么有运行时兜底，要么模型偶尔会写出无效图标名。

---

## 附录：产物清单

> 仓库中的抓包已脱敏：账号、设备、会话相关的头字段与 id 已替换，产品名替换为同长度的化名（Acme / Credits / PayCo），因此所有源码偏移量保持有效。脱敏脚本见 `scripts/sanitize-capture.py`。OpenAI 的运行时代码（runner、宿主 chunk）（未随仓库分发：属 OpenAI 的运行时代码，正文仅引用必要片段）。

| 文件 | 说明 |
|---|---|
| [`artifacts/genui-source.dil.md`](artifacts/genui-source.dil.md) | 模型产出的完整 DIL 源码（23,422 字符，40 个 `{@body}`，265 个组件标签） |
| [`artifacts/genui-compiled.js`](artifacts/genui-compiled.js) | 服务端编译产物（30,932 字节，323 次 `__dil.jsx`，108 次常量引用） |
| [`artifacts/genui-constants.json`](artifacts/genui-constants.json) | 字符串常量池（108 条） |
| [`artifacts/genui-fallback.md`](artifacts/genui-fallback.md) | 降级 Markdown |
| `artifacts/dil-runner.js` | DIL 运行时（184,775 字节，协议 v14） |
| `artifacts/dil-runner-iframe.html` | **沙箱 iframe 文档**（13,236 字节，含 CSP 与启动探针）—— 详见 [RUNNER-SANDBOX.md](RUNNER-SANDBOX.md) |
| [`captures/conversation-final.json`](captures/conversation-final.json) | 会话最终完整状态（含全部 metadata） |
| [`captures/stream-final-state.json`](captures/stream-final-state.json) | 按补丁重放出的流式最终状态 |
| [`captures/record-421-view-state.json`](captures/record-421-view-state.json) | 状态回传请求 |
| `captures/host-chunk-889520.json` | 宿主侧 GenUI 粘合代码 |
| [`captures/records-subset.json`](captures/records-subset.json) | 关键记录原始响应（凭据已脱敏） |

> 所有抓包文件中的 `authorization` / `cookie` / `x-conduit-token` / sentinel 令牌均已替换为 `<redacted>`。
