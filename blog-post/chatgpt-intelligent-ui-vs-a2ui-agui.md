---
title: 让 AI 直接回答出一个界面：拆解 ChatGPT Intelligent UI，对照 A2UI 与 AG-UI
slug: chatgpt-intelligent-ui-vs-a2ui-agui
url: /post/chatgpt-intelligent-ui-vs-a2ui-agui.html
date: '2026-10-08 18:00:00+08:00'
lastmod: '2026-10-08 18:00:00+08:00'
description: '从一次 ChatGPT 抓包和一个可运行的复刻出发，由浅入深讲清 Intelligent UI 怎么让模型「写程序」生成界面，以及它与 A2UI（写数据）、AG-UI（传输协议）的异同。'
toc: true
isCJKLanguage: true
tags: ['Generative UI', 'ChatGPT', 'A2UI', 'AG-UI', '架构设计']
---

# 让 AI 直接回答出一个界面

问 AI「帮我算一下房贷」，过去它会回一段文字：「贷款 100 万、30 年、利率 3.5%，月供约 4,490 元。」想换成 300 万？再问一遍。

现在 ChatGPT 可以直接回给你一个**能操作的小工具**：几个滑块调金额、年限、利率，月供跟着实时变化，下面还有一张图对比两种还款方式。你拖滑块时它不需要再问 AI，计算就在你的浏览器里完成。

这类能力叫**生成式界面（Generative UI）**。OpenAI 在 ChatGPT 里的实现叫 **Intelligent UI**（内部代号 DIL）；Google 牵头做了一个开放格式 **A2UI**；还有一个开源协议 **AG-UI**。三个名字经常被放在一起讨论，但它们解决的问题并不一样。

这篇文章想讲清楚两件事：Intelligent UI 到底是怎么做的，以及它和 A2UI、AG-UI 有什么异同。**不需要你用过 A2UI 或 AG-UI。** 文章由浅入深分四部分，读到第二部分结尾，就已经能讲清三者的区别。

> 关于来源：Intelligent UI 不对外开放。文中关于它的结论来自对一次 ChatGPT 生成过程的抓包分析，以及我写的一个能在本地跑起来的复刻；抓包已脱敏，例子里的产品名是化名。A2UI 与 AG-UI 的内容以撰写时（2026 年 10 月）的官方文档和规范为准，文中的 A2UI 消息都用 v0.9 官方 JSON Schema 校验过。凡是推断，文中会明说。

## 第一部分：思路

### 要做到这件事，必须回答三个问题

不管用哪种方案，让 AI 回答出一个界面，都绕不开三个问题：

1. **AI 用什么「语言」描述界面？** AI 只会输出文字，得有一种约定好的格式，告诉浏览器「这里放一个滑块、那里显示一个数字」。
2. **界面怎么从 AI 那里传到屏幕上？** AI 是一个字一个字往外吐的，复杂界面可能要写几十秒。总不能让用户干等，所以要边写边传、边传边显示。
3. **AI 写的东西，怎么安全地显示出来？** AI 写的内容不能完全信任：它可能写错，也可能被恶意提示词诱导，写出想偷数据的东西。显示之前必须有一道防线。

```d2 {title="所有生成式界面方案都要回答的三个问题"}
direction: down
classes: {
  q: {style: {fill: "#EFF6FF"; stroke: "#2563EB"; border-radius: 8; font-size: 18}}
  edge: {style: {fill: "#F8FAFC"; stroke: "#94A3B8"; border-radius: 8; font-size: 18}}
  end: {style: {fill: "#ECFDF5"; stroke: "#059669"; border-radius: 8; font-size: 18}}
}
ai: "AI 一个字一个字地输出" {class: edge}
qs: "要回答的三个问题" {
  direction: right
  q1: "① 用什么格式\n描述界面？" {class: q}
  q2: "② 怎么边写边传\n到屏幕上？" {class: q}
  q3: "③ 怎么保证显示\n出来是安全的？" {class: q}
  q1 -> q2 -> q3
}
ui: "用户看到一个能操作的界面" {class: end}
ai -> qs
qs -> ui
```

后面所有方案的区别，都可以归结为它们对这三个问题给出了不同答案。

### 两条路：让 AI 写数据，还是让 AI 写程序

对第一个问题，业界有两种根本不同的答案。

**第一条路，像点菜。** AI 给你一张清单：「一个滑块，叫『贷款金额』，范围 10 到 500；一行文字，显示『月供』。」浏览器（或手机 App）照着清单，用**自己已有的**组件把界面拼出来。清单里只有「要什么」，没有「怎么算」。

**第二条路，像写一个小程序。** AI 直接写一段程序：「有一个变量叫金额，一个叫年限；月供等于这个公式；滑块和变量绑在一起。」浏览器**运行**这段程序，界面和计算逻辑都由它产生。

```d2 {title="同一个需求的两条路"}
direction: down
classes: {
  ai: {style: {fill: "#EEF2FF"; stroke: "#6366F1"; border-radius: 8; font-size: 18}}
  data: {style: {fill: "#ECFDF5"; stroke: "#059669"; border-radius: 8; font-size: 18}}
  code: {style: {fill: "#FFF7ED"; stroke: "#EA580C"; border-radius: 8; font-size: 18}}
}
ai: "AI 收到：帮我做一个房贷计算器" {class: ai}
data: "路一：写数据（像点菜）" {
  direction: down
  list: "输出一张组件清单\n滑块 · 滑块 · 一行文字" {class: data}
  render: "客户端用自己的组件\n照着清单拼出界面" {class: data}
  calc: "拖动滑块后要重算？\n发回给 AI 去算" {class: data}
  list -> render -> calc
}
code: "路二：写程序" {
  direction: down
  prog: "输出一段小程序\n变量 + 公式 + 绑定" {class: code}
  run: "浏览器在隔离环境里\n运行这段程序" {class: code}
  calc: "拖动滑块后要重算？\n浏览器自己就算了" {class: code}
  prog -> run -> calc
}
ai -> data.list
ai -> code.prog
```

两条路各有得失：

| | 写数据（清单） | 写程序 |
|---|---|---|
| 能做什么 | 只能用已有组件，需要计算时要回去问 AI | 几乎什么都能算，交互在本地即时完成 |
| 安不安全 | 天然安全：清单本身不会「做」任何事 | 必须把程序关进严格的隔离环境里运行 |
| 写错了会怎样 | 通常只是某个组件显示不出来 | 程序可能整体跑不起来 |
| 能不能用在手机 App | 可以，用原生组件照单拼就行 | 很难，依赖浏览器的隔离能力 |

**A2UI 走第一条路，ChatGPT 的 Intelligent UI 走第二条路。**

### 三个名字，各管什么

还剩一个 AG-UI。它和前两者不在同一层，用寄快递来比喻最清楚：

- **A2UI** 规定的是**包裹里东西的格式**，也就是「界面清单」长什么样。
- **AG-UI** 是**快递公司和运单规则**：规定 AI 后端和前端之间怎么传消息，包括文字、工具调用、状态变化，也包括界面。
- **Intelligent UI** 是一家**自产自销**的公司：格式、运输、拆包显示全包了，而且装的是程序而不是清单。

```d2 {title="三者所在的层次：AG-UI 负责传，A2UI 规定传什么，Intelligent UI 自成一体"}
classes: {
  layer: {style: {fill: "#F8FAFC"; stroke: "#94A3B8"; border-radius: 8; font-size: 18}}
  open: {style: {fill: "#ECFDF5"; stroke: "#059669"; border-radius: 8; font-size: 18}}
  closed: {style: {fill: "#FFF7ED"; stroke: "#EA580C"; border-radius: 8; font-size: 18}}
}
open: "开放生态：可以组合使用" {
  direction: down
  backend: "AI 后端" {class: layer}
  agui: "AG-UI\n传输协议：事件、状态、工具调用" {class: open}
  a2ui: "A2UI\n界面格式：组件清单 JSON" {class: open}
  front: "前端 / App" {class: layer}
  backend -> agui: "发送"
  agui -> front: "送达"
  a2ui -> agui: "作为载荷之一"
}
closed: "ChatGPT 内部：闭环" {
  direction: down
  model: "模型" {class: layer}
  iui: "Intelligent UI\n格式 + 传输 + 执行 + 渲染" {class: closed}
  page: "ChatGPT 页面" {class: layer}
  model -> iui -> page
}
```

所以 AG-UI 和 A2UI 不是竞争关系，可以一起用：AG-UI 负责传输，传的内容是 A2UI 格式的界面。AG-UI 的文档自己也说得很明白：它不是生成式界面规范，而是 AI 与应用之间的「交互协议」，可以承载 A2UI 等多种界面格式。

## 第二部分：用同一个例子看三种做法

为了方便比较，下面都用开头那个计算器的简化版：两个滑块（金额、年限，利率固定 3.5%），一行显示月供。

### A2UI：AI 写一份「界面清单」

A2UI 由 Google 发起，CopilotKit 等社区参与，Apache 2.0 开源，撰写本文时的生产版本是 v0.9.1。

AI 输出的是一行行 JSON 消息。第一条，开一块「画布」，并指明用哪一套组件：

```json
{"version":"v0.9","createSurface":{"surfaceId":"loan",
  "catalogId":"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"}}
```

第二条，列出组件：

```json
{"version":"v0.9","updateComponents":{"surfaceId":"loan","components":[
  {"id":"root",   "component":"Column", "children":["amount","years","result"]},
  {"id":"amount", "component":"Slider", "label":"贷款金额（万元）", "min":10, "max":500, "value":{"path":"/amount"}},
  {"id":"years",  "component":"Slider", "label":"贷款年限",       "min":5,  "max":30,  "value":{"path":"/years"}},
  {"id":"result", "component":"Text",   "text":{"path":"/monthly"}}
]}}
```

第三条，填数据：

```json
{"version":"v0.9","updateDataModel":{"surfaceId":"loan","path":"/",
  "value":{"amount":100,"years":30,"monthly":"¥4,490"}}}
```

有两个设计值得注意。

**组件是平铺的，不是嵌套的。** 每个组件有一个 `id`，父组件用 `children` 列出子组件的 id（必须有一个叫 `root` 的根）。这样 AI 每写完一个组件就能先发出去，不必等整棵树写完，非常适合流式生成。

**组件不写死数值，而是指向一个「数据位置」。** `{"path":"/amount"}` 的意思是「去数据里的 `/amount` 找值」。界面结构和数据分开，改数据时不用重发组件。

```d2 {title="A2UI：组件平铺，用 id 互相引用，并绑定到数据模型里的路径"}
classes: {
  comp: {style: {fill: "#ECFDF5"; stroke: "#059669"; border-radius: 8; font-size: 18}}
  data: {style: {fill: "#EFF6FF"; stroke: "#2563EB"; border-radius: 8; font-size: 18}}
}
components: "updateComponents：平铺的组件列表" {
  root: "root\nColumn" {class: comp}
  amount: "amount\nSlider" {class: comp}
  years: "years\nSlider" {class: comp}
  result: "result\nText" {class: comp}
  root -> amount: "children"
  root -> years
  root -> result
}
model: "updateDataModel：数据模型" {
  a: "/amount = 100" {class: data}
  y: "/years = 30" {class: data}
  m: "/monthly = ¥4,490" {class: data}
}
components.amount -> model.a: "双向绑定" {style.stroke-dash: 4}
components.years -> model.y: "双向绑定" {style.stroke-dash: 4}
components.result -> model.m: "读取" {style.stroke-dash: 4}
```

一共只有四种消息：`createSurface`（开画布）、`updateComponents`（放组件）、`updateDataModel`（改数据）、`deleteSurface`（关画布）。

**用户拖动滑块之后呢？** 滑块和数据是双向绑定的，拖动后本地的 `/amount` 立刻变了。但 `monthly` 是 AI 算好填进来的，**客户端不知道怎么重新计算它**。A2UI 基础组件目录里的客户端函数只有格式化和校验两类（`formatCurrency`、`formatNumber`、`required`、`regex`……），没有「按公式计算」。

要更新月供，得把操作发回给 AI。基础目录里能挂「动作」的组件只有按钮，所以一般加一个「重新计算」按钮：

```json
{"id":"recalc", "component":"Button", "child":"recalc_label",
 "action":{"event":{"name":"recalculate",
   "context":{"amount":{"path":"/amount"}, "years":{"path":"/years"}}}}},
{"id":"recalc_label", "component":"Text", "text":"重新计算"}
```

用户点按钮后，客户端把动作连同当前的金额、年限发回 AI，AI 算出新月供，再发一条 `updateDataModel` 回来。**每次重新计算，都要和 AI 往返一次。**（宿主当然也可以扩展组件目录，自己实现一个「房贷计算器」组件来本地计算，但那样公式是宿主预先写好的，不是 AI 写的。）

**安全靠什么？** 每个客户端声明一份**组件目录（catalog）**，AI 只能从里面选。清单里没有任何可执行代码，最坏情况也只是显示了一个奇怪的界面。官方的说法是 Secure by Design：「是声明式数据格式，而不是可执行代码」。同一份清单可以在网页上用 Web 组件渲染，也能在 Flutter App 里用原生组件渲染，这是写数据这条路天然的优势。

### Intelligent UI：AI 写一段「小程序」

同样的计算器，在 Intelligent UI 里 AI 写出来的是这样一段东西（这段在我的复刻里可以直接运行）：

```text
这是一个房贷计算器，拖动滑块看看月供怎么变。

{@body const [amount,setAmount] = DIL.useState(100)}
{@body const [years,setYears] = DIL.useState(30)}
{@body const r = 0.035 / 12}
{@body const n = years * 12}
{@body const monthly = amount * 10000 * r * (1+r)**n / ((1+r)**n - 1)}

<box gap={3}>
  <slider label="贷款金额（万元）" value={amount} onChange={setAmount} min={10} max={500}/>
  <slider label="贷款年限" value={years} onChange={setYears} min={5} max={30}/>
  <title size="xl">每月还款 ¥{Math.round(monthly).toLocaleString()}</title>
</box>
```

逐段看：

| 部分 | 意思 |
|---|---|
| 第一行文字 | 普通说明文字，就是 Markdown |
| `{@body const [amount,setAmount] = DIL.useState(100)}` | 声明一个变量 `amount`，初始值 100，`setAmount` 用来修改它。熟悉 React 的人会认出这是 `useState` |
| `{@body const monthly = …}` | 月供公式，**写在 AI 的回答里** |
| `<slider value={amount} onChange={setAmount}/>` | 滑块显示 `amount`，拖动时调用 `setAmount` |
| `{Math.round(monthly)…}` | 把计算结果插进文字 |

关键区别：**公式是 AI 写的，而且在你的浏览器里运行。** 拖滑块时浏览器自己重算、立刻显示，完全不用回去问 AI。

这种格式内部叫 DIL，看上去像 Markdown 和 React 的 JSX 混在一起，这是有意为之：AI 最擅长写 Markdown，正文直接写；界面部分像 JSX，但只能用宿主提供的几十个标签，不能写任意 HTML 和 CSS，所以生成的界面风格始终和 ChatGPT 一致。

代价也很明显：浏览器要运行 AI 写的程序，就得先解决「这段程序不可信」的问题，ChatGPT 为此搭了一套相当重的隔离系统，第三部分会详细讲。

### AG-UI：负责「送快递」的那一层

AG-UI 是一个开源协议，定义 AI 应用的后端和前端之间**怎么传消息**。它不关心界面长什么样，只规定一组标准「事件」。一次对话可以想成后端不断往前端发一条条带类型的消息：

| 事件（`type` 字段的取值） | 意思 |
|---|---|
| `RUN_STARTED` / `RUN_FINISHED` | 一次回答开始 / 结束 |
| `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END` | 一段文字开始、陆续到达、结束 |
| `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` | AI 要调用一个工具，参数陆续到达 |
| `STATE_SNAPSHOT` | 当前完整的状态，直接替换掉手上的 |
| `STATE_DELTA` | 状态只改了这几处 |

最后两个值得多说一句，后面还会遇到。假设状态是 `{"amount":100,"years":30}`，要把金额改成 300，有两种发法：

```json
{"type":"STATE_SNAPSHOT", "snapshot": {"amount":300, "years":30}}
{"type":"STATE_DELTA",    "delta":    [{"op":"replace", "path":"/amount", "value":300}]}
```

第一种整份重发，简单但浪费；第二种只发变化，这种「改哪儿说哪儿」的格式就是 **JSON Patch**（互联网标准 RFC 6902）。「先给一份完整快照，之后只发补丁」是流式传输里很常见的做法，ChatGPT 内部用的也是同样的思路。

```d2 {title="AG-UI：每次运行都以 RUN_STARTED 开始、RUN_FINISHED 结束，中间是文字、状态等事件"}
shape: sequence_diagram
backend: "AI 后端"
frontend: "前端"
run1: "第一次运行" {
  backend -> frontend: "RUN_STARTED"
  backend -> frontend: "TEXT_MESSAGE_CONTENT：「这是一个计算器…」"
  backend -> frontend: "STATE_SNAPSHOT：{amount: 100, years: 30}"
  backend -> frontend: "RUN_FINISHED"
}
frontend -> backend: "用户把金额改成 300，前端发起新的运行"
run2: "第二次运行" {
  backend -> frontend: "RUN_STARTED"
  backend -> frontend: "STATE_DELTA：[replace /amount → 300]"
  backend -> frontend: "RUN_FINISHED"
}
```

回到快递的比喻：前端要显示 A2UI 界面时，AG-UI 负责把那几条 A2UI 的 JSON 送过去；它也能送别的格式。AG-UI 文档里列出的就有 A2UI、OpenAI 的 Open-JSON-UI，以及基于 iframe 的 MCP-UI。

### 放在一起比一比

| | A2UI | Intelligent UI | AG-UI |
|---|---|---|---|
| 是什么 | 界面描述格式 | 一整套闭环系统 | 前后端通信协议 |
| AI 输出的是 | 组件清单（JSON） | 小程序（DSL，编译成 JS） | 不规定 |
| 拖滑块后重算月供 | 点按钮发回 AI，AI 算好再发回来 | 浏览器本地即时完成 | 不涉及 |
| 安全靠 | 格式里没有可执行代码，组件来自白名单 | 一套严格的隔离沙箱 | 交给具体实现 |
| AI 写错的影响 | 通常只影响一个组件 | 可能整个程序跑不起来，需要大量容错 | 不涉及 |
| 手机原生 App | 支持 | 只有网页 | 不涉及 |
| 谁能用 | 开源 | 只在 ChatGPT 内部 | 开源 |

再对照开头的三个问题：

| | ① 用什么描述 | ② 怎么传 | ③ 怎么保证安全 |
|---|---|---|---|
| A2UI | 平铺的组件 JSON | 规范本身很薄，常借助 AG-UI 等 | 不执行代码 + 组件白名单 |
| AG-UI | 不管 | 标准事件流 + 快照/补丁 | 不管 |
| Intelligent UI | Markdown + 受控 JSX 的小语言 | 自有的补丁流 | 双层沙箱 |

三者也有共同点：

1. **都要边写边显示。** 没人愿意等 30 秒才看到界面。
2. **组件都由宿主提供，不由 AI 定义。** AI 只能描述用哪些组件，不能凭空造一个出来。
3. **都要把用户的操作送回 AI。** 用户在界面上做了什么，AI 下一轮需要知道。

如果只想了解大概，读到这里就够了。下面进入 Intelligent UI 的实现细节。

## 第三部分：深入 Intelligent UI 的实现

> 这一部分会用到一些前端概念（iframe、Web Worker、CSP），第一次出现时会简单解释。

### 全景：一次回答经过的五个环节

```d2 {title="Intelligent UI 的五个环节，以及用户操作回到下一轮对话的路径"}
classes: {
  server: {style: {fill: "#EEF2FF"; stroke: "#6366F1"; border-radius: 8; font-size: 18}}
  wire: {style: {fill: "#F8FAFC"; stroke: "#94A3B8"; border-radius: 8; font-size: 18}}
  sandbox: {style: {fill: "#FFF7ED"; stroke: "#EA580C"; border-radius: 8; font-size: 18}}
  page: {style: {fill: "#ECFDF5"; stroke: "#059669"; border-radius: 8; font-size: 18}}
}
model: "① 模型\n写 DIL 源码" {class: server}
compiler: "② 服务器\n编译成 JavaScript" {class: server}
stream: "③ 补丁流\n边写边推送" {class: wire}
sandbox: "④ 隔离环境\n运行程序，得到元素树" {class: sandbox}
render: "⑤ ChatGPT 页面\n画成真实界面" {class: page}
state: "用户的选择\n按变量名记录" {class: page}
model -> compiler -> stream -> sandbox -> render
render -> sandbox: "点击、拖动" {style.stroke-dash: 4}
render -> state
state -> model: "下一轮对话交给模型" {style.stroke-dash: 4}
```

我们抓到的那次真实生成，是一个有三个页签的计费控制台：

| 数据 | 数值 |
|---|---|
| AI 写的源码 | 23,422 字符 |
| 编译后的程序 | 30,932 字符 |
| 生成过程中服务器重新编译的次数 | 134 次 |
| 界面里的状态（选中的页签、各滑块的值……） | 15 个 |

还有一个细节：抓包里一条**纯文字**的回答，也带着一份编译后的程序，只有 232 字符，里面就渲染了一个文本元素。所以这不是一个可以开关的「模式」，而是 ChatGPT 所有回答默认走的渲染路径，普通回答只是恰好没用到交互组件。

### 编译器：AI 写错是常态

**为什么要编译。** 浏览器不能直接运行 DIL 源码，服务器上的编译器把它翻译成标准 JavaScript。前面那个计算器，编译结果的核心部分大致是：

```js
function __dilSafe(evaluate, fallback) { try { return evaluate() } catch { return fallback } }

DIL.render(__dil.jsx(() => {
  const [amount, setAmount] = DIL.useState(100, {key: "amount"});
  const [years, setYears]   = DIL.useState(30,  {key: "years"});
  const monthly = __dilSafe(() => (amount * 10000 * r * …), undefined);
  return __dil.jsx("box", {gap: 3},
    __dilSafe(() => __dil.jsx("slider", {value: amount, onChange: setAmount, …}), null),
    …);
}));
```

和源码相比，编译器偷偷加了三样东西，每一样都有讲究。

**第一样：给每个状态起名字。** 源码是 `DIL.useState(100)`，编译后变成 `DIL.useState(100, {key: "amount"})`，`key` 就是变量名。它有两个用处：AI 还在写的时候界面会被反复刷新，有了名字才能找回每个状态之前的值，你已经拖到 300 的滑块不会跳回 100；另外，用户的选择会按这个名字上报，下一轮 AI 看到 `amount: 300` 就知道指的是哪个滑块。抓包里那 15 个状态，编译后全部带上了以变量名命名的 `key`。

**第二样：给可能出错的地方套上保护罩。** `__dilSafe(() => 表达式, 备用值)` 的意思是：试着算，出错就用备用值，**别让错误扩散**。AI 写的公式可能引用了不存在的变量，可能对 `undefined` 取属性。没有保护罩时，一个小错误就让整个界面白屏；有了它，只是这一个值显示不出来。

我逐个对比了抓包里的编译结果，发现规则很精确：**属性或内容里有表达式的元素单独套一层保护罩，全是固定值的元素不套。** 一个下拉框的选项写错了，消失的只是这个下拉框，旁边的内容照常显示。

**第三样：把文字抽到一张表里。** 源码里的说明文字被统一抽进一个常量表，程序里只留编号，比如 `__dilConstants["3"]`。抓包里这张表有 108 条。

**从错误中恢复。** AI 是一个字一个字写的，编译器每隔一小段时间就把「目前为止的全部内容」重新编译一次。这意味着它面对的输入几乎总是不完整的：标签写了一半，括号没闭合，`{#if}` 还没写到 `{/if}`。

编译器的策略是**从不报错退出**：遇到不完整的结构，记一条「诊断」，用已经能确定的部分继续生成程序。

```json
{"code":"unclosed_block","action":"recovered_parse","line":66,"column":9,"directive":"if"}
```

意思是第 66 行第 9 列有个 `{#if}` 还没闭合，已经恢复处理。抓包里这样的诊断有 338 条，比程序本身的更新次数（134 次）还多。这个数字说明：**对边写边显示的系统来说，处理「写到一半」不是边缘情况，而是主要工作。**

至于为什么每次都从头编译而不是只编译新增部分：源码的中间状态几乎都不合法，增量编译要维护复杂的中间结构，而这份源码只有几十 KB，从头编译一次只要几毫秒，用一点算力换来大幅简化，很划算。

### 边写边显示：流式补丁

服务器和浏览器之间用的是 SSE（Server-Sent Events，一种让服务器持续向浏览器推消息的标准技术）。抓包里整条 2.5 MB 的连接上**只有一种消息**，叫 `delta`，内容是一个补丁：

```json
{"p":"/message/content/parts/0",            "o":"append",  "v":"…新写出来的几个字…"}
{"p":"/message/metadata/model_dil_v2/code", "o":"replace", "v":"function __dilSafe(…){…}"}
```

`p` 是要改的位置，`o` 是怎么改（`append` 追加、`replace` 替换、`add`、`remove`），`v` 是新值。这和前面 AG-UI 的 `STATE_DELTA` 是同一个思路，只是 AG-UI 把不同用途拆成了不同类型的事件，而 ChatGPT 只服务自己的前端，一种消息加路径约定就够了。

同一条连接里其实跑着两条线：

```d2 {title="同一条连接里的两条线：源码线不断追加，程序线不断整体替换"}
classes: {
  src: {style: {fill: "#F8FAFC"; stroke: "#94A3B8"; border-radius: 8; font-size: 18}}
  prog: {style: {fill: "#FFF7ED"; stroke: "#EA580C"; border-radius: 8; font-size: 18}}
  out: {style: {fill: "#ECFDF5"; stroke: "#059669"; border-radius: 8; font-size: 18}}
}
sse: "SSE 连接：只有 delta 一种消息" {
  direction: down
  a: "源码线\ncontent/parts/0 → append" {class: src}
  b: "程序线\nmodel_dil_v2/code → replace" {class: prog}
}
dev: "开发者查看、降级显示" {class: out}
box: "交给隔离环境重新运行\n（状态按名字保留）" {class: out}
sse.a -> dev
sse.b -> box
```

浏览器每收到一份新程序，就交给隔离环境重新运行；因为状态有名字，重新运行不会丢掉用户已经做过的操作。另外还有一个 `resume` 接口，带上「我收到第几条了」就能从中间接着收，对一个持续几十秒、几 MB 的连接来说很重要。

### 沙箱：怎么安全地运行 AI 写的代码

这是「写程序」这条路必须付出的代价，也是 Intelligent UI 工程量最大的部分。先认识两个工具：

- **iframe**：嵌在网页里的另一个独立网页。如果它来自另一个网址（「跨域」），浏览器会禁止它读写外面那个页面的内容，比如你的登录信息（cookie）和页面元素。
- **Web Worker**：在后台单独运行 JavaScript 的线程。它**没有页面**，不能画任何东西，只能计算并通过消息传递结果。

ChatGPT 把 AI 写的程序关进了两层「笼子」：

```d2 {title="两层隔离：外层断网且与 ChatGPT 页面不同源，内层连页面都没有"}
direction: right
classes: {
  host: {style: {fill: "#ECFDF5"; stroke: "#059669"; border-radius: 8; font-size: 18}}
  frame: {style: {fill: "#EFF6FF"; stroke: "#2563EB"; border-radius: 8; font-size: 18}}
  worker: {style: {fill: "#FFF7ED"; stroke: "#EA580C"; border-radius: 8; font-size: 18}}
  code: {style: {fill: "#FEF2F2"; stroke: "#DC2626"; border-radius: 8; font-size: 18}}
}
page: "ChatGPT 页面（能访问登录信息与真实组件）" {
  class: host
  iframe: "外层：跨域 iframe\nCSP 禁止一切网络请求" {
    class: frame
    worker: "内层：Web Worker\n没有页面，只能计算" {
      class: worker
      code: "AI 写的程序" {class: code}
    }
  }
  ui: "页面用自己的组件\n把树画成真实界面" {class: host}
  iframe.worker.code -> ui: "唯一能做的事：\n交出一棵元素树"
}
```

为什么要两层？因为每层各挡一部分风险：

| 风险 | 外层 iframe 挡住 | 内层 Worker 挡住 |
|---|---|---|
| 把你的数据偷偷发到外面的服务器 | ✓ | |
| 读取 ChatGPT 页面上的登录信息 | ✓ | |
| 在框里画一个假的「请重新登录」窗口骗你输密码 | | ✓（它根本没有页面） |
| 写个死循环把页面卡死 | | ✓（独立线程，可以直接终止） |

只有 iframe，程序可以在框里画假的登录框；只有 Worker，它和 ChatGPT 同源，网络和存储都是通的。两层叠起来，程序只剩下「计算并交出一棵树」这一件事能做。

**断网靠 CSP。** CSP（Content Security Policy，内容安全策略）是网页可以声明的一组规则，告诉浏览器「这个页面只允许加载哪些东西、连接哪些地址」。抓包里那个 iframe 页面声明的是：

```text
default-src 'none';                      默认什么都不允许
script-src 'sha256-…' 'unsafe-eval' …;   只允许一段指定的启动脚本，并允许运行字符串形式的代码
worker-src blob: data:                   只允许创建 Worker
```

`default-src 'none'` 且没有放行任何网络连接，意味着页面里的 `fetch`、`WebSocket`、加载图片、加载字体**全部会被浏览器拦下**。这比在代码里删掉 `fetch` 可靠得多：代码层面的限制可能被绕过，浏览器执行的规则不会。`'unsafe-eval'` 看起来吓人，但这里是必须的：这个页面存在的意义，就是运行一段字符串形式的程序。

**需要「复制」「打开链接」怎么办？** 程序关在笼子里，但有些事确实需要做，比如把一段文字复制到剪贴板。做法是在笼子里放「替身」：ChatGPT 页面告诉笼子「你可以用这几个能力」，给的却不是真函数，只是编号；笼子里把编号包成替身函数；程序调用替身时，替身只是往外发一条消息「请执行 3 号能力，参数是这段文字」；ChatGPT 页面检查参数后，**在自己这边**真正执行。

```d2 {title="能力以「替身」的形式进入隔离环境：真正的执行永远在 ChatGPT 页面"}
shape: sequence_diagram
code: "AI 写的程序（笼子里）"
stub: "替身函数（笼子里）"
page: "ChatGPT 页面"
code -> stub: "GenUI.copy(\"月供 ¥4,490\")"
stub -> page: "请执行 3 号能力，参数是这段文字"
page -> page: "检查参数，在页面里真正复制"
page -> stub: "结果"
stub -> code: "返回"
```

能用的能力一共只有 5 个（复制、打开链接、发起新一轮提问、打开实体详情、调用插件），参数检查非常严格。比如调用插件时，参数必须恰好包含两个字段，还要检查对象的原型，防止一种叫「原型污染」的攻击。

**为什么启动这么复杂。** ChatGPT 页面把这套沙箱的启动拆成了 72 个带名字的阶段（创建 iframe、加载脚本、创建 Worker、健康检查……），每一步单独记录成败。这么细，是因为「跨域 iframe + 后台 Worker」在不同浏览器、插件、公司网络策略下有非常多种失败方式，而用户看到的永远只有一种症状：「界面没出来」。不把每一步记下来，线上出问题几乎无从查起。

### 组件和状态：界面怎么和产品、和下一轮对话连起来

**从数据树到真实界面。** 隔离环境里的程序跑完，交出来的不是界面本身，而是一棵描述界面的数据。前面那个计算器实际输出的树是这样的（略去开头的说明文字）：

```json
{"t":"box","p":{"gap":3},"c":[
  {"t":"slider","p":{"label":"贷款金额（万元）","value":100,"onChange":{"__dilFn":"fn1"},"min":10,"max":500}},
  {"t":"slider","p":{"label":"贷款年限","value":30,"onChange":{"__dilFn":"fn2"},"min":5,"max":30}},
  {"t":"title","p":{"size":"xl"},"c":[{"t":"#text","v":"每月还款 ¥"},{"t":"#text","v":"4,490"}]}
]}
```

`t` 是组件类型，`p` 是属性，`c` 是子元素。注意 `onChange` 不是函数，只是一个编号 `fn1`：函数本身留在隔离环境里，不能也不需要传出来。

ChatGPT 页面用自己的组件把这棵树画出来。用户拖动滑块时，页面只回传一句话：「`fn1` 被触发了，新值是 300」。隔离环境里的程序执行 `setAmount(300)`，重新计算，交出一棵新树，页面再更新。整个过程都在浏览器里，不经过服务器。

```d2 {title="一次拖动：页面只回传编号和新值，计算和新树都由隔离环境产生"}
shape: sequence_diagram
user: "用户"
page: "ChatGPT 页面"
box: "隔离环境"
user -> page: "把金额滑块拖到 300"
page -> box: "fn1 被触发，参数 300"
box -> box: "setAmount(300)，重新运行程序"
box -> page: "新的元素树（月供 ¥13,471）"
page -> user: "只更新变化的部分"
```

更新时页面会比对新旧两棵树，只改变化的部分。这对输入框尤其重要：AI 还在写时界面会反复刷新，如果每次都重建输入框，用户正在输入的内容和光标就会丢失。

**宿主组件：把产品里现成的卡片拿来用。** 除了滑块、文字、表格这些基础组件，AI 还能写一些大写开头的标签，比如 `<MemoryCite />`，它们是 ChatGPT 产品里**已经做好的完整组件**。抓包里的组件名单有两份：30 个常驻的（引用、代码块、商品卡片、航班卡片……），以及 283 个按需加载的，几乎涵盖了 ChatGPT 做过的所有卡片：股票、体育比分、天气、学习卡片，还有约 50 个医疗计算器。

AI 写 `<MemoryCite />` 时并不知道这个组件怎么实现，中间有一层「查表」：服务器告诉页面「这个位置的 MemoryCite 已确认可用」，页面才把真实组件放上去；对不上的只显示占位框。AI 没法靠编造一个名字调出不该用的组件。这和 A2UI 的组件目录是同一个思想：**AI 只能从宿主提供的组件里选。**

**状态回到 AI：下一轮对话「记得」你做了什么。** 这是 Intelligent UI 和「生成一个网页」最不一样的地方。界面显示出来后，页面会把所有带名字的状态发给服务器（抓包，已脱敏）：

```json
POST /backend-api/conversation/{对话id}/message/{消息id}/dil/view_state

{"updates": [{
  "scope": "root",
  "state": {
    "tab": "overview", "period": "7", "channel": "all", "incident": false,
    "model": "balanced", "turns": 8000, "retry": 5, "rewards": 15, "wallet": 250,
    "ledger": [], "message": "", "search": "", "statusFilter": "all",
    "riskOnly": false, "selectedAudit": "EVT-1042"
  },
  "client_update_id": "…"
}]}
```

`state` 里的 15 个名字，和编译时加上的 15 个 `key` 完全一致。下一轮对话的请求里有一个字段 `genui_state_snapshots`，用来把这些状态交给 AI。

```d2 {title="状态回环：用户的选择按变量名上报，下一轮对话交给 AI"}
direction: down
classes: {
  page: {style: {fill: "#ECFDF5"; stroke: "#059669"; border-radius: 8; font-size: 18}}
  server: {style: {fill: "#EEF2FF"; stroke: "#6366F1"; border-radius: 8; font-size: 18}}
}
turn1: "这一轮" {
  direction: right
  ui: "用户拖动滑块\n300 万、20 年" {class: page}
  report: "上报 view_state\n{amount: 300, years: 20}" {class: page}
  ui -> report
}
store: "服务器记下这条消息的状态" {class: server}
turn2: "下一轮" {
  direction: right
  ask: "提问：按我现在的\n参数每月还多少？" {class: page}
  model: "AI 读到状态快照\n按 300 万、20 年回答" {class: server}
  ask -> model
}
turn1.report -> store
store -> turn2.model: "随下一轮请求带上"
```

我在复刻里试过这个场景：生成房贷计算器后把滑块拖到「300 万、20 年」，然后问「按我现在的参数，等额本金每月要还多少」，AI 直接按 300 万、20 年作答，用户不用复述自己调了什么。

（需要说明：抓包只覆盖了第一轮，当时 `genui_state_snapshots` 是空的，所以**状态具体以什么格式交给 AI，是推断**。复刻的做法是只把用户改动过的状态整理成一段文字，放在用户问题前面。）

和另外两者对比：A2UI 通过「动作」把操作发回 AI，可以选择附带整份数据；AG-UI 有专门的状态事件。三者解决的是同一个问题，只是时机不同：A2UI 和 AG-UI 在交互发生时就告诉 AI，Intelligent UI 先记下来、下一轮再给，因为它的交互本来就不需要 AI 参与。

### 复刻时踩到的坑

为了验证上面的理解，我把五个环节都实现了一遍。抓包里那份真实源码在复刻里能零错误编译，三个页签都能操作，状态名字和上报内容与抓包完全一致。

但换成 DeepSeek 现场生成后，问题才真正暴露出来。ChatGPT 自己的模型很少写错，通用模型错得多。用「帮我做一个 MacBook 选购指南」「帮我创建一个 Golang 高并发系统原理」反复测，常见错误是这些：

| AI 写了什么 | 后果 | 复刻怎么处理 |
|---|---|---|
| 在 `<code>` 里放了一段 Go 代码，里面全是 `{` `}` | 编译器把 Go 代码当成 DIL 表达式，整个程序无法运行 | `<code>`、`<pre>` 里的内容一律当纯文字 |
| `{@body const T = {…}` 漏了最后一个 `}` | 后面整篇内容都被当成这一行的一部分 | 这种指令都是单行的，在这一行结尾截断 |
| 用了 `value={usage}`，却从没声明 `usage` | 控件消失，有时整个界面空白 | 看到 `usage` 和 `setUsage` 成对出现，自动补上声明 |
| 整篇回答包在 ```` ```html ```` 里 | 页面上出现一串反引号 | 去掉这几行，记一条诊断 |

前两种最危险，因为它们让**整个程序**无法运行：浏览器运行程序时，任何一处语法错误都会让整段代码失败；而且 AI 每多写几个字、编译器每重新编译一次，都会再失败一次，用户看到的就是一直空白。

复刻最后加了两道保险：

```d2 {title="复刻加的两道保险：坏片段换成安全值，整份程序仍有问题就退回纯文字"}
classes: {
  step: {style: {fill: "#EFF6FF"; stroke: "#2563EB"; border-radius: 8; font-size: 18}}
  ok: {style: {fill: "#ECFDF5"; stroke: "#059669"; border-radius: 8; font-size: 18}}
  warn: {style: {fill: "#FFF7ED"; stroke: "#EA580C"; border-radius: 8; font-size: 18}}
}
src: "AI 写到一半的源码" {class: step}
frag: "第一道：逐段检查\n每个表达式、属性、语句单独做语法检查" {class: step}
fix: "不合法的片段\n换成安全的默认值" {class: warn}
whole: "第二道：拼好后整体检查" {class: step}
run: "交给隔离环境运行" {class: ok}
text: "退回只显示文字" {class: warn}
src -> frag
frag -> fix: "有错"
fix -> whole
frag -> whole: "没错"
whole -> run: "能解析"
whole -> text: "仍不能解析"
```

用 12 份真实 AI 输出、共 30,184 个「写到一半」的版本做测试：每个版本编译出来的程序都能正常运行，没有一个需要退回纯文字。

**要强调的是，这两道保险是复刻自己加的，没有抓包依据。** ChatGPT 用的模型很可能专门针对这种格式训练过，错误会少得多。这一节真正想说明的是：**用通用模型走「写程序」这条路，编译器的容错要比原版做得更重。**

## 第四部分：总结

### 该怎么选

| 你的情况 | 更合适的方向 | 原因 |
|---|---|---|
| 自己的模型、自己的网页，想让回答变成能操作的工具 | 写程序（类似 Intelligent UI） | 本地即时交互、能做复杂计算；隔离环境和编译器的成本由你自己承担 |
| 第三方 AI 要往别人的 App 里显示界面 | 写数据（A2UI） | 双方互不信任，「不运行对方的代码」是最清楚的安全边界 |
| 要同时支持网页、iOS、Android | 写数据（A2UI） | 一份清单可以映射成各平台的原生组件 |
| 主要是表单、卡片、确认操作 | 写数据（A2UI） | 现成组件够用，不需要复杂计算 |
| 需要本地筛选、排序、模拟计算（计算器、配置器、仪表盘） | 写程序 | 每次操作都问一次 AI，体验和成本都受不了 |
| 已有 AI 后端，要接多种前端 | AG-UI 做传输，内容按上面选 | AG-UI 解决的是「怎么传」，不是「传什么」 |

如果真要用通用模型走「写程序」这条路，复刻得出的几条经验：

1. **编译器的容错要做重。** 逐段检查语法、自动补全漏掉的声明、代码块按纯文字处理，在通用模型上都是必需的。
2. **把出错的影响控制在一个元素以内。** 每个可能出错的元素单独套保护罩。
3. **给 AI 的说明里放一个完整、能运行的例子。** 实测比写多少条规则都管用；这个例子本身也要放进测试，保证它一直能跑。
4. **开启「思考」模式要显示进度。** 开启后首屏要多等二三十秒，界面上必须让用户知道 AI 正在想，否则会以为卡住了。

### 哪些是确定的，哪些是推断

**有抓包直接证据：**

- AI 写的是源码，服务器反复整体编译（134 次），以补丁流推给浏览器
- 编译结果的结构：保护罩、常量表、状态名字、元素级保护规则、图表组件的校验
- 隔离环境的结构：禁止联网的跨域 iframe 里运行 Worker，能力以「替身」形式提供
- 30 + 283 个宿主组件的名单，以及「查表」式的解析
- 状态上报的格式，15 个状态名字与编译结果一一对应

**推断，或没有覆盖到：**

- **给 AI 的系统提示词**完全没抓到；复刻里用的是根据编译结果反推、再按 DeepSeek 的出错情况调整的版本。
- **服务器编译器的内部实现**看不到，只能看到输出。复刻的保护规则和原版很接近但不完全相同：同一份源码，复刻套了 61 处保护罩，原版是 56 处。
- **状态交给 AI 的具体格式**没有样本。
- **宿主组件进入隔离环境的方式**：原版传的是替身函数，复刻传的是名字加查表，效果相同但机制不同。
- **样本只有一次完整生成**，来自一个账号、一个模型版本。

---

完整的抓包笔记、脱敏后的数据和可运行的复刻都在 [Disdjj/intelligent-ui-demo](https://github.com/Disdjj/intelligent-ui-demo)。复刻不需要任何密钥就能跑（会回放抓包里的原始界面），右上角的开发者面板可以看到每一轮的源码、编译结果、补丁记录和状态上报。

参考：
- A2UI：[官网](https://a2ui.org/)、[v0.9 规范](https://a2ui.org/specification/v0.9-a2ui/)
- AG-UI：[事件](https://docs.ag-ui.com/concepts/events)、[状态](https://docs.ag-ui.com/concepts/state)、[与生成式界面规范的关系](https://docs.ag-ui.com/concepts/generative-ui-specs)
