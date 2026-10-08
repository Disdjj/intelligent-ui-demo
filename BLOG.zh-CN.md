# 让模型写界面：拆解 ChatGPT Intelligent UI，并与 AG-UI、A2UI 对照

> 本文基于对 ChatGPT「Intelligent UI」一次完整生成的抓包分析，以及一个可运行的复刻实现（本仓库 `replica/`）。抓包已脱敏，产品名均为化名。文中凡是「抓包可见」的结论都标了证据来源；凡是推断，会明说是推断。

---

## 目录

1. [先看结果：一次回答里发生了什么](#1-先看结果一次回答里发生了什么)
2. [全景：五层管线](#2-全景五层管线)
3. [DSL：为什么是「Markdown + 受控 JSX」](#3-dsl为什么是markdown--受控-jsx)
4. [编译器：把「不合法」当常态](#4-编译器把不合法当常态)
5. [流式协议：一种事件，一套补丁](#5-流式协议一种事件一套补丁)
6. [沙箱：iframe + Worker 两层隔离](#6-沙箱iframe--worker-两层隔离)
7. [宿主渲染与组件解析](#7-宿主渲染与组件解析)
8. [状态回环：界面上的选择如何回到模型](#8-状态回环界面上的选择如何回到模型)
9. [复刻中踩到的坑：通用模型写 DSL 有多不稳](#9-复刻中踩到的坑通用模型写-dsl-有多不稳)
10. [对照 AG-UI 与 A2UI](#10-对照-ag-ui-与-a2ui)
11. [取舍：什么时候该选哪条路](#11-取舍什么时候该选哪条路)
12. [哪些是确定的，哪些是推断](#12-哪些是确定的哪些是推断)

---

## 1. 先看结果：一次回答里发生了什么

让 ChatGPT「做一个可交互的计费控制台」，它返回的不是一段 Markdown，而是一个能操作的界面：三个工作区可以切换，滑块调参数后毛利实时重算，点「试扣」会往一个模拟账本里写一行，选中一条审计事件右侧显示详情。

抓包里，这条回答的 `message.metadata.model_dil_v2` 包含：

| 字段 | 内容 |
|---|---|
| `code` | 30,932 字符的 JavaScript，沙箱执行入口 |
| `constants` | 108 条字符串常量 |
| `fallbackMarkdown` | 687 字符的降级 Markdown |
| `requiredComponents` | `["MemoryCite"]` |
| `appData.opGenui.componentResults` | 宿主组件的解析结果 |

而模型实际吐出来的，是一份 23,422 字符的「源码」（`artifacts/genui-source.dil.md`），开头长这样：

```text
下面是一个完整的 **Intelligent UI 交互实验台**。它模拟一个 AI 产品的 Billing Control Center……

{@body const [tab,setTab] = DIL.useState("overview")}
{@body const [period,setPeriod] = DIL.useState("7")}
……
{@body const trendData = Array.from({length:n},(_,i)=>({…}))}
{@body function chargeOnce(){ if(wallet<creditsPerTurn){ setMessage("余额不足…"); return } … }}

<box border radius="2xl" padding={3} gap={4}>
  <row align="center" justify="between" wrap="wrap">
    <title size="lg">Acme Billing</title>
    <badge color={incident?"warning":"success"}>{incident?"演练异常":"系统正常"}</badge>
  </row>
  <segmented-control block size="lg" value={tab} onChange={setTab} options={[…]}/>
  {#if tab==="overview"}
    …
    <Chart content={{"chartType":"line","xKey":"period","series":[…],"data":trendData}}/>
  {/if}
</box>
```

**模型写的是程序，不是数据。** 状态、派生计算、事件处理函数都在源码里，交互发生时不需要回服务端问模型。这是 Intelligent UI 和后文两个协议最根本的区别，后面所有的工程复杂度都从这里来。

还有一个细节值得先记住：抓包里一条**纯文本**回答（「我用一个……场景来演示：做成可交互的计费控制台」）也带着 `model_dil_v2.code`，编译产物只有 232 字节，里面就渲染了一个 `<text>`。也就是说，**这不是一个可以开关的模式，而是所有回答默认的渲染路径**。普通回答只是恰好没有用到交互组件。

## 2. 全景：五层管线

```
① 模型            ② 服务端编译器              ③ 传输            ④ 沙箱（客户端）           ⑤ 宿主渲染
DIL 源码  ──流式──► parse → codegen   ──SSE 补丁──► iframe ─► Worker   ──元素树──► DOM
  ▲                 （每次整体重编译）     {p,o,v}       执行 JS，输出可序列化的树      data-d-component
  │                                                                                     │
  └────────── genui_state_snapshots ◄── POST …/dil/view_state ◄── 语义键状态 ◄───────────┘
```

| 层 | 职责 | 抓包证据 |
|---|---|---|
| ① 模型 | 输出 Markdown + `{@body}` 语句 + 受控 JSX | `message.content.parts[0]` 的流式 `append` |
| ② 编译器 | 源码 → JS + 常量池 + 降级 Markdown + 诊断 | `model_dil_v2/code` 被整体 `replace` 134 次 |
| ③ 传输 | 一个 SSE 事件类型，内容是 JSON Patch 风格的补丁 | 整条 2.5 MB 的流只有 `event: delta` |
| ④ 沙箱 | 跨域 iframe（CSP `default-src 'none'`）里起 blob Worker | `runner.html` 的 CSP 与启动探针 |
| ⑤ 渲染 | 树 → 真实组件，按名字解析宿主组件 | `data-d-component` 标记、30 + 283 个宿主组件 |
| 回环 | 状态带语义键上报，下一轮交给模型 | `POST …/dil/view_state` 请求体 |

下面逐层拆。

## 3. DSL：为什么是「Markdown + 受控 JSX」

源码由三种东西混合而成：

| 构造 | 语法 | 编译去向 |
|---|---|---|
| 正文 | 普通 Markdown | 变成 `title` / `text` / `list` 元素，文本进常量池 |
| 语句 | `{@body const x = …}` | 提升到渲染函数体内 |
| 界面 | 小写标签 `<box>` `<slider>`，表达式 `{x}`，`{#if}` / `{#each}` | 变成 `__dil.jsx(tag, props, …children)` |

大写标签是另外两类：`<Chart>` 由编译器自己展开（见 §4），`<MemoryCite>` 这类由宿主解析（见 §7）。

这个设计看起来像 JSX，但有几处刻意的不同，每一处都对着一个「模型容易写错」的点：

- **正文就是 Markdown。** 模型最擅长写的就是 Markdown，回答里大部分内容本来就是文字。让它直接写，而不是包进 `<text>`，可以减少大量标签噪音。编译器负责把 `## 标题`、`**粗体**`、`1. 列表` 转成对应元素（抓包里 `## 这个示例体现了什么？` 编译成 `__dil.jsx("title",{"size":"lg"},…)`）。
- **语句和界面分开写。** `{@body}` 一行一条语句，全部写在界面之前。这让「先定义状态再使用」成为文档结构本身，而不是靠模型自觉。
- **控制流是块语法，不是表达式。** `{#if}…{:else if}…{/if}` 比 `cond ? <a/> : <b/>` 更容易流式写对：块有明确的开始和结束标记，编译器在中途遇到未闭合的块，知道该怎么恢复。
- **组件只有宿主给的那些。** 标签是一个固定词表，没有 `<div style>`，也不能写 CSS。所有视觉决策都在宿主一侧，生成的界面因此和产品本身的风格保持一致。

为什么不直接让模型写 React 或 HTML？我的理解是三个原因：

1. **流式写到一半必须能用。** React 组件文件写到一半是语法错误，什么也渲染不出来。DIL 的结构（语句在前、界面在后、块语法）让编译器能在任意前缀上产出「已经写好的那部分」。
2. **执行环境是受限的。** 沙箱里没有 DOM，没有网络。React 生态的大部分东西在里面都用不了，不如定义一个只包含能用部分的小方言。
3. **输出要能被宿主检查。** 编译产物是一棵可序列化的元素树，宿主可以逐个节点决定渲染什么。这比执行任意 HTML 可控得多。

## 4. 编译器：把「不合法」当常态

编译器跑在服务端，**每次都从头编译整份源码**，而不是增量编译。抓包里 `model_dil_v2/code` 被整体替换了 134 次，从 446 字符一路长到 30,932 字符。

整体重编的理由很直接：源码的中间态几乎总是不合法的（标签写到一半、花括号没闭合），增量编译需要维护复杂的中间结构，而这份源码只有几十 KB，从头解析一次只要几毫秒。

### 4.1 四个产出

| 产出 | 作用 |
|---|---|
| `code` | 沙箱执行的程序 |
| `constants` | 字符串常量池：所有正文进池子，代码里只留 `__dilConstants["n"]` 引用 |
| `fallbackMarkdown` | 没有沙箱时（搜索摘要、旧客户端、沙箱崩溃）显示的静态版本 |
| `recoveryDiagnostics` | 解析器从错误中恢复的记录，每条带行号、列号、动作 |

### 4.2 产物长什么样

```js
function __dilSafe(evaluate,failureValue){try{return evaluate()}catch{return failureValue}}

DIL.render(__dil.jsx(()=>{
  const __dilConstants=DIL.useConstants();
  const __dilModelDataBindings=DIL.useAppData((appData)=>appData.opGenui?.modelDataBindings??{});
  const [tab,setTab] = DIL.useState("overview",{key:"tab"});
  const n = __dilSafe(()=>(period==="7"?7:period==="30"?10:12),undefined);
  …
  return __dil.jsx("box",{"border":true,"radius":"2xl","padding":3,"gap":4}, …);
},{"key":"body:0"}));
```

对照模型写的源码，可以看出编译器做了三件事：

**① `useState` 加上语义键。** 源码是 `DIL.useState("overview")`，产物是 `DIL.useState("overview",{key:"tab"})`，键就是变量名。15 个状态全部如此。这个键是状态在服务端的地址（见 §8）。

**② 每个派生值包一层 `__dilSafe`。** `const n = period==="7"?…` 变成 `const n = __dilSafe(()=>(…),undefined)`。一个派生值算错，只是它变成 `undefined`，不会让整个渲染函数抛错。

**③ 会出错的元素单独包一层。** 我逐个比对了产物里的元素：**凡是属性或直接子节点里有表达式的元素，都被包成 `__dilSafe(()=>(__dil.jsx(…)),null)`**，全是静态属性的元素则不包。抓包里 53 个包了的元素，没有一个例外。这让「降级的单位」恰好是元素：一个下拉框的 `options` 引用了不存在的变量，消失的只是这个下拉框。

这三条加起来，几乎免费地把「一处报错，整个界面白屏」变成了「局部降级」。这是我认为整个设计里性价比最高的一个决定。

### 4.3 `<Chart>` 不是宿主组件

`<Chart content={{…}}/>` 看起来是一个大写的宿主组件，但它没有出现在 `requiredComponents` 里。产物开头有一个编译器注入的函数 `DilChartContentPropShim`：它校验模型给的图表配置（`chartType` 是否合法、`data` 是否是对象数组、`series` 是否有 `dataKey`），然后降级成内建的 `chart` / `pie-chart` 元素。配置不合法就返回 `fallback`，不报错。

模型很容易把图表配置写错，在编译期插入一个校验层，比让每个宿主组件自己防御要干净得多。

### 4.4 恢复式解析

抓包里与诊断相关的补丁有 338 条，比代码补丁（134 条）还多：

```json
{"code":"unclosed_block","action":"recovered_parse","line":66,"column":9,"directive":"if"}
{"code":"unterminated_braced_value","action":"recovered_parse","line":17,"column":5}
```

解析器从不报错终止：遇到未闭合的标签、块、花括号，记一条诊断，然后用「当前能确定的部分」继续产出代码。诊断条数比代码补丁还多，本身就说明：**对一个流式生成的 DSL 来说，从错误中恢复不是边缘情况，而是主流程。**

## 5. 流式协议：一种事件，一套补丁

### 5.1 三个接口

```
POST /backend-api/f/conversation/prepare   → { conduit_token }      把这次流式请求指派给某台网关
POST /backend-api/f/conversation           → text/event-stream
POST /backend-api/f/conversation/resume    { conversation_id, offset } → 从事件序号续传
```

`resume` 的 `offset` 是事件序号，断线后可以从中间接着收。这对一个要传几 MB、持续几十秒的流很重要。

### 5.2 整条流只有一种事件

整条 2.5 MB 的流里，SSE 的 `event:` 字段只出现过 `delta`。所有语义都在补丁里：

```json
{"p":"/message/content/parts/0",            "o":"append",  "v":"…新写出的源码…"}
{"p":"/message/metadata/model_dil_v2/code", "o":"replace", "v":"function __dilSafe(…){…}"}
{"p":"/message/metadata/genui_components",  "o":"add",     "v":[{"type":"charts_widget_v2",…}]}
```

`p` 是 JSON Pointer，`o` 是 `append` / `add` / `replace` / `remove`。同一个流里同时有两条线：

- **源码线**：`content/parts/0` 不断 `append`，这是给人看的（开发者视图、降级显示）。
- **程序线**：`model_dil_v2/code` 不断整体 `replace`，这是给沙箱跑的。

客户端每收到一次新的 `code`，就送进沙箱重新执行一遍；沙箱保留状态（§6.4），所以用户已经拖过的滑块不会因为模型还在写而跳回原位。

### 5.3 `genui_components`：组件的边界随流增长

还有一条独立的元数据，标注「源码里哪一段是一个组件」：

```json
{"type":"charts_widget_v2","tree_range":[58,59],"start_index":8021,"end_index":8039}
```

流式过程中，这个组件的 `end_index` 被反复替换：8021 → 8039 → 8148 → 8209。组件写完了没有、能不能开始渲染，客户端看这个区间就知道。

复刻时发现一个细节：这些偏移量是 **Unicode 码点**，不是 JavaScript 字符串下标。抓包里的 8021，在 JS 里是第 8024 个字符，因为前面有三个 emoji 各占两个 UTF-16 单元。复刻的编译器按码点计算后，四个组件的区间和抓包逐字一致。

## 6. 沙箱：iframe + Worker 两层隔离

模型写的是任意 JavaScript，必须当作不可信代码执行。ChatGPT 用了两层：

```
chatgpt.com 宿主页
  └─ <iframe src="…/dil/v14/runner.html">   ① 无网络（CSP default-src 'none'），opaque origin
       └─ new Worker(blob:…)               ② 无 DOM
            └─ 执行模型生成的 JS            ③ 不可信代码
                 └─ 输出可序列化的元素树 → postMessage 回宿主
```

### 6.1 CSP 是主隔离墙

`runner.html` 的 CSP（抓包可见）：

```
default-src 'none';
script-src 'sha256-…' 'self' https://cdn.platform.openai.com/assets/dil/ 'unsafe-eval';
base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none';
worker-src blob: data:
```

- `default-src 'none'` 且没有 `connect-src`：沙箱里 `fetch`、`XHR`、`WebSocket`、图片、字体**全部被浏览器拦下**。这是「无 IO」的硬保证，比在 JS 层删掉 `fetch` 更根本：JS 层的白名单可能被绕过，CSP 不会。
- `script-src` 用哈希钉死那一段内联启动脚本，而不是 `'unsafe-inline'`。在 CSP3 下，出现哈希后 `'unsafe-inline'` 自动失效，任何被注入的其他内联脚本都跑不起来。
- `'unsafe-eval'` 是必须的：沙箱的本职工作就是执行一段字符串形式的代码。
- `worker-src blob:` 是唯一的例外，专门为了能起 Worker。

iframe 本身不带 `allow-same-origin`（运行时代码发出的请求带 `Origin: null`），所以它和 chatgpt.com 是不同源，读不到宿主的 cookie 和 DOM。

### 6.2 两层各挡一半

| | iframe 挡住的 | Worker 挡住的 |
|---|---|---|
| 网络 | ✓（CSP） | |
| 宿主 cookie / DOM | ✓（不同源） | |
| 自己的 DOM（伪造登录框、钓鱼） | | ✓（Worker 里没有 DOM） |
| 卡死主线程（死循环） | | ✓（独立线程，可以直接 terminate） |

只有 iframe，模型代码可以在 iframe 里画一个假的登录框；只有 Worker，Worker 和宿主同源，网络和存储都是通的。两层叠加，模型代码只剩下「计算并返回一棵树」这一件事能做。

### 6.3 宿主能力以「桩」的形式进沙箱

沙箱里能调用 `GenUI.copy(text)`、`GenUI.openUrl(url)` 这些能力，也能渲染 `<MemoryCite>` 这样的宿主组件。但宿主组件是 React 组件，不可能序列化送进 Worker。做法是：

1. 宿主把可用的函数和组件编码成占位符 `{__oaiDilGlobalFunction: "<id>"}`；
2. Worker 里把占位符还原成「调用时 postMessage 回宿主」的代理函数；
3. 模型代码调用代理，宿主收到 `invokeGlobal {id, args}`，**在宿主自己的 origin 里**真正执行。

沙箱里跑的永远只是桩。能做的外部动作只有 5 个（`copy` / `openUrl` / `issueNewTurn` / `openEntityDetail` / `runPluginTool`），参数校验严格到语法层：比如 `runPluginTool` 的参数必须恰好有两个自有属性，原型必须是 `Object.prototype` 或 `null`，用来挡原型污染。

### 6.4 状态跨重编译保留

流式过程中，同一个 runner 会收到上百次新程序。如果每次都重置状态，用户在模型还没写完时拖动的滑块会一直跳回初始值。

Worker 里的运行时按「语义键」保存状态：`useState(init, {key:"tab"})` 第一次调用时用 `init`，之后每次重新执行程序都读回已有的值。键是变量名而不是调用顺序，所以模型在前面插入一个新状态，也不会让后面的状态错位。

### 6.5 72 个启动阶段

宿主一侧把沙箱启动拆成了 72 个带名字的阶段（`frame_boot`、`worker_create`、`runner_create`、`health_probe`……），每个阶段记录开始、结束和失败，最后按优先级归纳出「最可能的根因」（比如 `runner_module_csp_enforced`、`health_probe_expired`）。

这一块的工程量说明了一件事：跨域 iframe 加 blob Worker 的组合，在不同浏览器、扩展、企业策略下有非常多的失败方式，而且它们在用户眼里看起来都一样，都是「界面没出来」。不做这么细的阶段记录，线上几乎没法排查。

## 7. 宿主渲染与组件解析

### 7.1 沙箱输出的是一棵数据树

Worker 执行完程序，得到的不是 DOM，而是一棵可以 `postMessage` 的树：标签名、属性、子节点。事件处理函数不能序列化，被换成 `{__dilFn: "fn3"}` 这样的引用，函数本身留在沙箱里。

宿主拿到树后渲染成真实组件，每个节点打上 `data-d-component="box|row|slider|…"` 标记。用户点击时，宿主只回传「点了 fn3，值是什么」，由沙箱决定发生什么、再输出一棵新树。这个往返完全在浏览器里，不经过服务端，所以交互是即时的。

宿主按位置和标签比对新旧两棵树：标签没变的节点原地更新，DOM 元素保持不变。这一点对输入框很关键：模型还在流式输出新版本时，用户正在打字的输入框不会因为重新渲染而丢失焦点。

### 7.2 宿主组件：30 个常驻 + 283 个按需

runner 里硬编码了两份组件名单。常驻的 30 个包括 `MemoryCite`、`Citation`、`CodeBlock`、`ProductCard`、`FlightCard` 等；按需加载的 283 个几乎涵盖了 ChatGPT 过去做过的所有卡片：股票、体育比分、天气、学习卡片、约 50 个医疗计算器……

也就是说，ChatGPT 把既有的卡片组件统一收编成了 GenUI 的宿主组件库。模型在源码里写一个大写标签，就能用上一个由产品团队实现、样式和数据都经过审核的完整组件。

### 7.3 解析靠一层间接表

模型写 `<MemoryCite />`，编译器给它分配一个 `__resolutionId`。服务端决定这个 id 解析成哪个真实组件，把结果放进 `appData.opGenui.componentResults[id] = {status:"resolved", componentName:"MemoryCite"}`。runner 渲染时查表：名字对得上、状态是 `resolved`，才挂载真实组件，否则显示占位。

这层间接带来两个好处：

- **模型不需要知道组件实现。** 它只要知道「有个东西叫 MemoryCite」，具体渲染什么、要不要加载、用户有没有权限，都是服务端和宿主决定的。
- **模型不能用名字越权。** 一个 `componentResults` 里没有的名字，写了也只是占位。

## 8. 状态回环：界面上的选择如何回到模型

这是 Intelligent UI 和「生成一个网页」最不一样的地方：用户在界面上的操作，模型下一轮能看到。

### 8.1 上报

界面首次渲染后，客户端把所有带键的状态 POST 出去（抓包，已脱敏）：

```http
POST /backend-api/conversation/{cid}/message/{mid}/dil/view_state

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

← {"status":"success","updated_scopes":0,"message_id":"…","conversation_id":"…"}
```

`state` 里的 15 个键，和编译产物里 15 个 `useState(…,{key})` 的键**一个不差**。键就是模型起的变量名，所以模型下一轮读到 `{"tab":"audit","riskOnly":true}` 时，它知道这是自己写的哪个控件、代表什么。

几个字段的作用：

- `scope`：抓包里只有 `root`，字段的存在说明设计上支持组件级作用域。
- `client_update_id`：每次上报一个新 id，服务端可以据此去重，重试不会把状态回滚。
- `updated_scopes: 0`：这次上报只是首次渲染时的初始值。我的理解是「和已有值相同的上报不算更新」，复刻也按这个语义实现，但这一点没有直接证据。

### 8.2 回灌

下一轮对话的请求体里有一个字段 `genui_state_snapshots`。抓包只覆盖了第一轮（值是空数组），没有抓到非空的样本，所以**快照具体以什么格式交给模型，是推断**。复刻里的做法是：只把用户改动过的状态整理成一段上下文，作为系统消息放在用户问题前面。

实测效果：在复刻里用 DeepSeek 生成一个房贷计算器，把滑块拖到「300 万、20 年」后追问「按我现在的参数，等额本金每月要还多少」，模型直接按这组参数回答，用户不需要再复述一遍。

### 8.3 什么能存进状态

状态要经过 JSON 序列化才能上报，所以函数、`Date`、循环引用这些都存不进去。复刻的服务端会校验：必须是普通对象、能 JSON 往返、不超过 16 KB。这也间接约束了模型：状态应该是「用户选了什么」，而不是「整个计算结果」。派生值每次重新算就好。

## 9. 复刻中踩到的坑：通用模型写 DSL 有多不稳

本仓库的 `replica/` 把上面五层都实现了一遍：编译器、SSE 补丁流、iframe + Worker 沙箱、渲染器、状态回环。抓包里那份 23,422 字符的真实源码，在复刻里编译零诊断，三个工作区都能用，状态键和 `view_state` 请求体完全一致。

但换成通用模型（DeepSeek）现场生成后，问题才真正暴露出来。我用「帮我做一个 MacBook 选购指南」「帮我创建一个 Golang 高并发系统原理」两个 prompt 反复测，遇到的失败几乎都属于下面几类：

| 模型的写法 | 后果 | 复刻的处理 |
|---|---|---|
| 在 `<code>` 里写 Go 代码：`for i := 0; … { wg.Add(1) }` | 花括号被当成 DIL 表达式，整个程序解析失败，后续上百次重编译全部报错 | `<code>` / `<pre>` 内容按纯文本处理 |
| `{@body const T = {a:{…}}` 漏了最后一个 `}` | 平衡扫描吞掉后面整篇文档 | 指令是单行的：在这一行末尾结束 |
| 控件用了 `value={usage} onChange={setUsage}`，却从没声明 `usage` | 控件消失，有时整个界面空白 | 按 `x` / `setX` 配对自动声明，初值取控件的第一个选项 |
| 整篇包在 ```` ```html ```` 代码块里 | 反引号被渲染成正文 | 丢掉围栏行，记一条诊断 |

前两类是最危险的，因为它们让**整个程序**无法解析。沙箱用 `new Function(code)` 执行，任何一处语法错误都意味着整个界面一片空白，而且流式过程中每次重编译都会失败。

复刻最后加了两道防线：

1. **逐片段语法校验。** 编译器把每个表达式、属性、语句单独做一次语法检查（只解析不执行），不合法的替换成安全值，并记一条诊断。
2. **整程序兜底。** 拼完的程序再检查一次，万一仍然不合法，就输出降级 Markdown 而不是一个会抛错的程序。

用 12 份真实模型输出的 30,184 个流式前缀做性质测试：编译出的程序全部可以解析，没有一次需要退到降级文本。这些曾经出错的输出现在存在 `replica/test/fixtures/` 里作为回归测试。

**需要说清楚：这些修复层是复刻自己的设计，没有抓包依据。** ChatGPT 那份产物里的 338 条恢复诊断说明它也在处理大量不合法的中间态，但 ChatGPT 用的模型很可能专门为这个 DSL 训练过，错误的种类和频率应该和通用模型差别很大。这一节真正说明的是：**如果你想用通用模型做同样的事，编译器的容错要比原版做得更重。**

## 10. 对照 AG-UI 与 A2UI

> 本节关于 AG-UI 和 A2UI 的描述，以撰写时（2026 年 10 月）两者的官方文档为准：AG-UI 的 [事件文档](https://docs.ag-ui.com/concepts/events) 与 [Generative UI 说明](https://docs.ag-ui.com/concepts/generative-ui-specs)，A2UI 的 [官网](https://a2ui.org/) 与 [v0.9 规范](https://a2ui.org/specification/v0.9-a2ui/)。两个项目都还在快速演进。

### 10.1 先摆正位置：三者不在同一层

AG-UI 的文档自己说得很清楚：「AG-UI is not a generative UI specification」，它是一个 **User Interaction protocol**，负责 agent 和应用之间双向的运行时连接。它同时声明可以承载 A2UI、Open-JSON-UI、MCP-UI 等界面规范。

所以更准确的对照是：

| | 层次 | 回答的问题 |
|---|---|---|
| **AG-UI** | 传输 / 交互协议 | agent 和前端之间怎么传消息、工具调用、状态 |
| **A2UI** | 界面描述格式 | agent 用什么格式描述一个界面 |
| **Intelligent UI** | 一整套私有系统 | 从模型输出到可交互界面的全部环节，含传输、格式、执行、渲染 |

Intelligent UI 在三者里比较特殊：它的传输层（补丁流）对应 AG-UI 的位置，它的 DSL 对应 A2UI 的位置，但它还多了一层两者都没有的东西：**在客户端执行模型写的代码**。

### 10.2 AG-UI：事件流协议

AG-UI 定义了一组带类型的事件，按类别大致是：

- **生命周期**：`RunStarted` / `RunFinished` / `RunError`、`StepStarted` / `StepFinished`
- **文本消息**：`TextMessageStart` / `TextMessageContent` / `TextMessageEnd`
- **工具调用**：`ToolCallStart` / `ToolCallArgs` / `ToolCallEnd` / `ToolCallResult`，参数以 JSON 片段流式到达
- **状态**：`StateSnapshot`（整份状态，客户端直接替换）与 `StateDelta`（一组 RFC 6902 JSON Patch 操作）、`MessagesSnapshot`
- **推理、子 agent、活动**，以及 `Raw` / `Custom` 两个扩展口

和 Intelligent UI 的传输层对照：

| | AG-UI | Intelligent UI |
|---|---|---|
| 事件类型 | 多种，带明确语义 | 只有 `delta` 一种，语义全在补丁路径里 |
| 增量格式 | `StateDelta` = JSON Patch | `{p,o,v}`，形似 JSON Patch，多了 `append` |
| 状态模型 | 快照 + 增量，一份 run 级状态 | 消息文档整体打补丁，状态单独走 `view_state` |
| 界面载荷 | 不规定，可承载 A2UI 等 | 固定为 `model_dil_v2` |
| 断线恢复 | 文档允许客户端重新请求快照 | `resume` + 事件序号续传 |

思路几乎一样：**都用「快照 + JSON 补丁」做流式增量**。区别在于 AG-UI 把语义显式化成事件类型，方便不同框架互通；Intelligent UI 只服务一个客户端，所以用一种事件加路径约定就够了。

### 10.3 A2UI：声明式组件 JSON

A2UI 由 Google 发起（CopilotKit 等参与），Apache 2.0 许可，当前生产版本是 v0.9.1。服务端到客户端只有四种消息：

```json
{"version":"v0.9","createSurface":   {"surfaceId":"s1","catalogId":"…"}}
{"version":"v0.9","updateComponents":{"surfaceId":"s1","components":[
  {"id":"root","component":"Column","children":["title","budget"]},
  {"id":"title","component":"Text","text":"预算"},
  {"id":"budget","component":"Slider","value":{"path":"/budget"}}
]}}
{"version":"v0.9","updateDataModel": {"surfaceId":"s1","path":"/budget","value":10000}}
{"version":"v0.9","deleteSurface":   {"surfaceId":"s1"}}
```

几个关键设计：

- **扁平的邻接表。** 组件不嵌套，而是一个扁平数组，父组件用 `children: [id…]` 引用子组件，必须恰好有一个 `id` 为 `root` 的组件。这对流式生成非常友好：每个组件写完就能发，不用等整棵树闭合。
- **结构与数据分离。** 组件属性可以绑定到数据模型的 JSON Pointer 路径（`{"path":"/budget"}`）。输入组件双向绑定，改动先只更新本地数据模型。
- **动作回传。** 组件声明 `action.event`，用户触发时客户端发 `action` 消息（含 `name`、`surfaceId`、`sourceComponentId`、`context`），由 agent 决定下一步，再发新的 A2UI 消息。
- **组件目录。** 客户端声明自己支持哪些组件（catalog），agent 只能用目录里的组件。官方称之为「Secure by Design」：「Declarative data format, not executable code」。

### 10.4 核心分歧：传代码还是传数据

把三者放在一起，最本质的差异只有一个：

| | Intelligent UI | A2UI |
|---|---|---|
| 模型输出 | **程序**（DSL → JS） | **数据**（组件 JSON + 数据模型） |
| 交互逻辑在哪执行 | 客户端沙箱 | 本地只有数据绑定和受限函数调用，其余回 agent |
| 「拖滑块重算月供」 | 本地即时，不回服务端 | 需要 agent 往返，或依赖客户端函数 |
| 安全边界 | 重型沙箱：CSP + 跨域 iframe + Worker + 能力桩 | 格式本身：没有可执行代码，组件来自白名单 |
| 一处写错的后果 | 可能整个程序无法解析（§9） | 一个组件或一个字段无效 |
| 流式单元 | 每次整体重编译 | 按组件 id 增量 |
| 跨平台 | 只有 Web（依赖浏览器沙箱） | Web、Flutter、Angular 等原生渲染 |
| 表达力上限 | 任意计算、筛选、模拟 | 受组件目录和绑定能力限制 |

**Intelligent UI 选择了表达力。** 一份回答就是一个小应用，筛选、排序、模拟计算全在本地完成，延迟为零。代价是一整套重工程：服务端编译器、恢复式解析、两层沙箱、72 个启动阶段的诊断、能力桩和严格的参数校验。只有同时掌握模型、编译器、运行时和前端的一方，才负担得起这套东西。

**A2UI 选择了边界。** agent 和渲染界面的客户端往往不属于同一方，比如第三方 agent 往某个 App 里投送界面。这时候「不执行对方的代码」是最自然的安全边界，跨平台原生渲染也随之变得可能。代价是复杂逻辑要回到 agent 那边，每次交互多一次往返。

**AG-UI 不参与这个选择。** 它负责把事件和状态可靠地传过去，载荷是 A2UI 的 JSON 还是一段 DSL，它都能承载。三者其实可以组合：用 AG-UI 做传输，载荷用 A2UI；或者在自己可控的前端里，载荷换成类似 DIL 的代码。

### 10.5 共同点

尽管路线不同，三者在几件事上的结论是一致的：

1. **流式增量是刚需。** 没人愿意等 30 秒才看到界面。三者都用某种「快照 + 补丁」的形式让界面边生成边出现。
2. **组件来自宿主，不来自模型。** Intelligent UI 的固定标签词表和 283 个宿主组件，A2UI 的 catalog，本质都是「模型只能描述，不能定义」。
3. **状态要能回到 agent。** Intelligent UI 的 `view_state`，A2UI 的 `action` 加可选的 `sendDataModel`，AG-UI 的状态事件，都在解决同一个问题：agent 需要知道用户在界面上做了什么。
4. **格式要对模型友好。** A2UI 选扁平 JSON，Intelligent UI 选 Markdown + JSX，出发点相同：让模型更容易一次写对，并且写到一半也能用。

## 11. 取舍：什么时候该选哪条路

| 你的场景 | 更合适的方向 | 理由 |
|---|---|---|
| 自己的模型、自己的前端，想让回答变成可操作的工具 | 类 Intelligent UI（传代码） | 本地交互零延迟，表达力最强；沙箱和编译器的成本由你一方承担 |
| 第三方 agent 往别人的 App 里投送界面 | A2UI（传数据） | 双方互不信任，「不执行代码」是最干净的边界 |
| 需要同时支持 Web、iOS、Android | A2UI | 声明式 JSON 可以映射到各平台的原生组件 |
| 主要是表单、卡片、确认流程 | A2UI | 组件目录足够覆盖，不需要任意计算 |
| 需要本地筛选、排序、模拟计算（计算器、配置器、仪表盘） | 类 Intelligent UI | 每次交互都回 agent，体验和成本都扛不住 |
| 已有 agent 框架，要接多个前端 | AG-UI 做传输，载荷按上面选 | 它解决的是互通，不是界面格式 |

如果真的要用通用模型走「传代码」这条路，复刻的经验是：

1. **编译器的容错要做重。** 逐片段语法校验、未声明状态的自动补全、代码块按纯文本处理，这些在原版里可能不需要，在通用模型上必不可少。
2. **元素是降级的单位。** 每个带动态属性的元素单独包 `try`，一处出错只丢一个元素。
3. **系统提示词里放一个完整、可运行的例子。** 实测比任何规则描述都管用。提示词本身也要进测试：本仓库有一个测试专门检查提示词里的例子能零诊断编译并运行。
4. **思考模式是延迟和质量的取舍。** 开启推理时首屏要多等二三十秒，界面上一定要显示进度，否则用户会以为卡住了。

## 12. 哪些是确定的，哪些是推断

**有抓包直接证据：**

- 模型输出 DSL 源码，服务端整体重编译 134 次，以补丁流推送
- 编译产物的结构：`__dilSafe`、常量池、`useState` 语义键、元素级包装规则、`<Chart>` shim
- 沙箱的承载形式：跨域 iframe（CSP `default-src 'none'`）内的 blob Worker，能力以桩的形式注入
- 30 + 283 个宿主组件名单，`componentResults` 间接解析
- `view_state` 的请求与响应格式，15 个状态键与产物一一对应
- `genui_components` 的区间语义与码点偏移

**推断或未覆盖：**

- **系统提示词**完全没抓到。复刻里的提示词是根据产物反推、再按通用模型的失败调出来的。
- **服务端编译器内部**看不到，只有输出。复刻的包装规则和原版高度相似但不完全一致（同一份源码，复刻包了 61 处，原版 56 处）。
- **`genui_state_snapshots` 的非空格式**没有样本，回灌方式是推断。
- **宿主组件的注入方式**：原版注入函数桩，复刻用字符串标签加间接表，行为等价但机制不同。
- **样本只有一次完整生成**，来自一个账号、一个模型版本。

---

### 附：复刻怎么跑

```bash
cd replica
npm install
npm start            # mock agent，回放抓包源码，不需要任何密钥
npm test             # 98 个测试，含抓包对照与 3 万个流式前缀的性质测试
```

接真实模型（任意 OpenAI 兼容接口）：

```bash
DIL_LLM_BASE_URL=https://api.deepseek.com \
DIL_LLM_API_KEY=<your key> \
DIL_LLM_MODEL=deepseek-flash \
npm start
```

打开 http://127.0.0.1:8787/ ，右上角 `</>` 是开发者面板，可以看到每一轮的协议日志、源码、编译产物、组件通道和状态上报。
