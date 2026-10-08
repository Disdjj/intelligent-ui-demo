# DIL Runner 的 iframe + Worker 双层沙箱是怎么搭起来的

> 注：runner 与 iframe 原文件（未随仓库分发：属 OpenAI 的运行时代码，正文仅引用必要片段）。

> 补全 [ANALYSIS.md](ANALYSIS.md) 第 12 节「存疑 2：沙箱的具体承载形式」。
> 新增抓包：记录 **2116**（`runner.html`）、**2124/2126**（iframe 内二次拉取 runner bundle）。
> 产物：`artifacts/dil-runner-iframe.html`（13,236 字节）、`artifacts/dil-runner.js`（184,775 字节）

---

## 0. 一句话

`https://cdn.platform.openai.com/deployments/dil/v14/runner.html` 是一个**专门为运行模型生成代码而造的跨域空白页**，它靠 **CSP 把网络能力全部掐死**，然后：

```
chatgpt.com 宿主页
  └─ <iframe src=".../deployments/dil/v14/runner.html">   ← ① 无网络的域（CSP default-src 'none'）
       └─ new Worker(blob:…)                              ← ② 无 DOM 的域（Worker + 全局白名单）
            └─ eval(模型生成的 30 KB JS)                    ← ③ 不可信代码
                 └─ 输出「编码后的渲染树」→ 回传宿主 React 落地
```

**版本号钉在两个地方**：URL 路径 `/v14/` 和所有握手消息里的 `protocolVersion: 14` —— 宿主可以按协议版本灰度切换到不同部署目录。

---

## 1. iframe 文档本身（`runner.html`）

### 1.1 骨架

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="
      default-src 'none';
      script-src 'sha256-5OnC/c0sEfhMMvQuXMcrgJR+ftu16IOuoBLhR1w0rLA='
                 'self'
                 https://cdn.platform.openai.com/assets/dil/
                 'unsafe-eval';
      base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none';
      worker-src blob: data:" />
    <script>/* 内联启动探针 ~250 行 */</script>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DIL Runner</title>
    <script type="module" crossorigin
            src="/assets/dil/runner-C-vppISG.js"
            data-dil-runner-module
            data-dil-evaluation-checkpoint></script>
  </head>
  <body>…</body>
</html>
```

### 1.2 CSP 才是真正的隔离墙

| 指令 | 值 | 作用 |
|---|---|---|
| `default-src` | `'none'` | **没有 `connect-src` / `img-src` / `font-src` ⇒ 沙箱内 `fetch`、`XHR`、`WebSocket`、`<img>`、字体全部被 CSP 拦死**。这是"无 IO"的硬保障，比 API 白名单更根本 |
| `script-src` | 一个 SHA-256 哈希 + `'self'` + runner 目录 + `'unsafe-eval'` | **只允许那一段内联 bootstrap**（用哈希而非 `'unsafe-inline'`）。CSP3 下出现哈希时 `'unsafe-inline'` 自动失效 ⇒ 注入进这个文档的任何其他内联脚本都跑不起来 |
| `'unsafe-eval'` | — | **必须开**。模型代码要求值。所以隔离策略不是"禁 eval"，而是"允许 eval 但什么都没有" |
| `worker-src` | `blob: data:` | Worker 的来源：`blob:` 是主路径，`data:` 是回退 |
| `base-uri` | `'none'` | 防 `<base>` 劫持相对路径（`src="/assets/dil/runner-*.js"` 是相对的，这条很必要） |
| `frame-src` | `'none'` | **嵌套到此为止**，这个 iframe 不能再嵌 iframe |
| `form-action` / `object-src` | `'none'` | 常规收紧 |

> 这也回答了我上一份报告里的一个疑点：沙箱全局白名单里**确实有 `eval` 和 `Function`**。原因在此——CSP 显式放开 `'unsafe-eval'`，安全性由「无网络 + 无 DOM + 无同源」提供，而不是靠禁动态求值。

### 1.3 内联 bootstrap：一个 ~250 行的"为什么没起来"探针

它不是功能代码，**全部是启动可观测性**，而且默认关闭：

```js
// 只有 URL hash 带 #dil-diagnostics=1 才启用全套打点
if (new URLSearchParams(location.hash.slice(1)).get("dil-diagnostics") !== "1") {
  addEventListener("error", reportModuleError, true);   // 平时只留这一根线
  return;
}
```

关键手法：

```js
// ① 与 runner.js 互相打点的不可篡改钩子
Object.defineProperty(window, "__oaiDilBootstrap", {
  value: Object.freeze({
    documentBootId,                      // crypto.randomUUID()
    moduleEvaluationStarted() { … }      // runner.js 第一行回调它
  })
});
```

`runner.js` 的第一行正是：

```js
try{ window.__oaiDilBootstrap?.moduleEvaluationStarted?.() }catch{}
```

⇒ **两个文件互相对表**，用来区分"文档已到但 bundle 没开始求值"和"bundle 开始求值了"。这是区分 CDN 慢、CSP 拦、bundle 抛异常这三种失败的关键。

```js
// ② 诊断直接回宿主，targetOrigin 用 "*"（宿主的 origin 未知且可能是任意域）
parent.postMessage({ __oaiDilFrame:true, kind:"diagnostic", protocolVersion:14,
                     record:{ realm:"bootstrap", sequence:++sequence, documentBootId, ... } }, "*");
```

```js
// ③ 三类失败被区分得很细
try {
  const entries = performance.getEntriesByName(event.target.src, "resource");
  if (entries.length === 1 && entries[0].responseStatus === 403)
    modulePolicyDenied = true;          // 403 ⇒ 判定为 CSP 拒绝，而不是网络错误
} catch {}
…
timing_unavailable | timing_ambiguous | timing_missing   // 三种不同的"拿不到计时"
… stackUnavailable                                        // 跨域脚本异常没有 stack
```

```js
// ④ 诊断探针：测事件循环还活着吗（检测 iframe 被节流/冻结）
addEventListener("message", (event) => {
  if (event.source === parent && message.kind === "diagnosticProbe" && probes++ < 4) {
    setTimeout(() => record("event_loop", "fired", { elapsedMs: now() - startedAtMs }), 0);
  }
});
```

还全程记录 `visibilitychange` / `pagehide` / `pageshow` / `freeze` / `resume` / `securitypolicyviolation`（把 CSP 违规映射成 `module_load` / `worker_create` 两类操作）。

代码注释也很实在：

```js
// The preload scanner can start this document's module request before
// the inline bootstrap runs. The resource timeline is document-local.
// Zero, including for a known 200 response, is not an HTTP failure.
```

---

## 2. 握手：`ready` + transferable MessagePort

`runner.js` 求值完成后（模块入口，偏移 @183695 附近）：

```js
const manager = new DilRunnerManager({ createWorker, diagnostics });
const channel = new MessageChannel();
channel.port1.addEventListener("message", onHostMessage);
channel.port1.start();

window.addEventListener("message", onWindowMessage);          // 只留给 diagnosticProbe
window.addEventListener("pagehide", e => {
  if (!e.persisted) { channel.port1.close(); manager.dispose(); }   // bfcache 感知的清理
});

// 关键：把 port2 作为 transferable 交给宿主
window.parent.postMessage(
  { __oaiDilFrame: true, kind: "ready", protocolVersion: 14 },
  "*",
  [channel.port2]
);
```

拿回执之后，**宿主 → iframe 的主通道就是这条 MessagePort**，不再走 `window.postMessage`。好处：结构化、有序、不需要 origin 校验（port 本身即凭证）。

### 宿主要发的第一条业务消息（`createRunner`）

带严格校验：

```js
function isCreateRunner(m){
  return m != null && typeof m == "object"
      && m.__oaiDilFrame === true
      && m.kind === "createRunner"
      && m.protocolVersion === 14
      && typeof m.compiledDil === "string"      // ← 那 30,932 字节的 JS
      && typeof m.runnerId   === "string";
}
function isDisposeRunner(m){ /* kind:"disposeRunner" + protocolVersion + runnerId */ }
```

`{kind, protocolVersion, compiledDil, runnerId}` + 可选的 `data` / `dilComponents` / `statePersistence` / `transports` / `globals`。

---

## 3. 第二层：Worker 里的"unsafe runner"

### 3.1 Worker 是怎么造出来的

Worker 的沙箱源码**整段内联在 runner.js 里**，运行时变成 Blob：

```js
const workerSource = '…dil_sandbox + dil_renderer 的完整实现…';

const workerBlob = new Blob([
  "(self.URL || self.webkitURL).revokeObjectURL(self.location.href);",   // ← 第一行
  workerSource
], { type: "text/javascript;charset=utf-8" });

function createWorker(name) {
  let url;
  try {
    url = workerBlob && (self.URL || self.webkitURL).createObjectURL(workerBlob);
    if (!url) throw "";
    const w = new Worker(url, { name: name?.name });
    w.addEventListener("error", () => (self.URL || self.webkitURL).revokeObjectURL(url));
    return w;
  } catch {
    // 回退路径：data: URL
    return new Worker("data:text/javascript;charset=utf-8," + encodeURIComponent(workerSource),
                      { name: name?.name });
  }
}
```

三个细节：

1. **`revokeObjectURL(self.location.href)` 放在 Worker 代码第一行** —— Worker 一启动就把自己那个 `blob:` URL 撤销掉。之后这个 URL 不再存在，既省句柄也防止被复加载。
2. **`data:` 回退** —— 因为不是所有环境都允许 `blob:` Worker，所以 CSP 里 `worker-src blob: data:` 两个都要写。
3. **`new Worker(blobUrl)` 不在 DOM 里** —— Worker 没有 `document`/`window`，这是"无 DOM"层的来源。

### 3.2 Worker 启动三段（诊断阶段名就是证据）

```js
// worker 侧 bootstrap（@180374 附近，变量名已还原语义）
emit("lifecycle", { kind: "worker_ready" });

const globals = trace("decode_globals", () =>
  decodeGlobals(o.globals, (id, args) =>
    commands.invokeGlobal({ id, args, ...interactionCapability })));

const persistState = trace("decode_persistence", () => …);
if (persistState && typeof persistState !== "function")
  throw new Error("DIL state persistence is not available");

const runner = trace("unsafe_runner", () => new DILRunner(o.compiledDil, {
  ...options,
  data: o.data,
  dilComponents: o.dilComponents,
  globals,
  onError:      g => { version++; emit("snapshot", { error: serializeError(g), version }); },
  onOperations: g => { version++; emit("snapshot", { error: null, operations: g, version }); },
  runWithExecutionAttribution: g => …   // 把宿主回调归属到具体 runnerId
}));
```

### 3.3 宿主函数怎么"进"沙箱：**不是注入，是回调桩**

这是整个设计里最巧的一环：

```
宿主                          iframe                       Worker
─────────────────────────────────────────────────────────────────────
encode_globals
  (把宿主组件/函数编码成
   {__oaiDilGlobalFunction:"<id>"} 占位)
      │
      │  createRunner { globals: 编码后的占位树 }
      ▼
                          createRunner 校验
                          建 data MessageChannel
      │                                          │
      └──────────── port2 + 消息 ────────────────►│ decode_globals
                                                 │  (把占位树还原成
                                                 │   会 postMessage 回宿主的代理)
                                                 ▼
                                              unsafe_runner:
                                              eval(compiledDil)
                                                 │  调用代理
      ◄──────────── invokeGlobal {id,args} ───────┤
   真的执行宿主函数
   （GenUI.copy / MemoryCite 渲染…）
      ──────────── result ──────────────────────►│
```

判定依据（源码）：

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

⇒ **沙箱里跑的永远只是"桩"**，真实组件和真实动作（复制、开链接、发起新一轮）在宿主 origin 执行。这同时解释了 `GenUI.copy()` 为什么能在沙箱里"用"——它只是 `invokeGlobal` 的一次 round-trip。

### 3.4 渲染结果怎么"出"沙箱

```
Worker: onOperations(ops) → emit("snapshot", {operations, version})
   → iframe: snapshot_forward（并缓存 lastSnapshotVersion）
   → 宿主: snapshot_receive → apply_tree
   → React: react_snapshot → react_materialize → react_commit
   → 出错: react_node_error → fallback
```

回传的是**增量渲染操作** + `version` 单调递增号（`pendingRequests` 里 `replayed` 的消息在重连后会去重）。所以宿主那侧的 `data-d-component="box"` 是"apply_tree 的产物"，不是模型直接给的 HTML。

---

## 4. 宿主侧：72 个启动阶段

runner.js 里内嵌了一份**跨 realm 共用的操作词汇表**（诊断 schema），顺序即真实流水线：

```text
host_setup → encode_globals → read_persistence → acquire_frame
  → iframe_create → iframe_load → iframe_resource
    → observer_bootstrap → module_load → module_resource → module_entry → frame_ready
      → manager_create → worker_create → worker_control → worker_module → harden_worker → runner_create
        → worker_ready → decode_globals → decode_persistence → unsafe_runner
          → runtime_construct → seed_runtime → hydrate_state
            → prepare_source → update_source → compile → evaluate
              → render → render_operations → snapshot_post
                → commit_state → persist_state → flush → flush_render → flush_effects → restore_source
                  → react_snapshot → react_materialize → react_commit → react_snapshot_effect
```

外加旁路阶段：
`command`、`host_call`、`snapshot_receive`、`snapshot_forward`、`apply_tree`、`notify`、`host_error`、`fallback`、`render_result`、`frame_timer`、`worker_timer`、`request_timer`、`health_probe`、`idle_probe`、`visibility`、`pagehide`、`pageshow`、`freeze`、`resume`、`frame_probe`、`event_loop`、`recovery`、`quarantine`、`runner_dispose`、`worker_stop`、`frame_dispose`、`message`、`error`、`coverage`。

几个值得注意的名字：

- **`acquire_frame`** —— 在 `iframe_create` 之前，暗示 **iframe 可能被复用/池化**（不是每条消息都新建）。
- **`unsafe_runner`** —— OpenAI 自己把 Worker 里那一段叫 "unsafe runner"，命名很诚实。
- **`harden_worker`** —— Worker 起来后先加固（就是我上份报告里的 `lockDownSandboxGlobal` / `hardenSandboxGlobal` / `DILSandboxRegExp`），**然后再** `runner_create` 收代码。
- **`quarantine` + `recovery`** —— 有隔离/恢复机制：某个 runner 出问题后被 quarantine（不再接收事件），但收到新的 `setCompiledDil` 时还有机会 `recovery`。

---

## 5. 流式更新：代码怎么"换"进去

iframe 的 `rememberHostCommand()` 是增量更新的入口：

```js
rememberHostCommand(session, msg){
  switch (msg.command) {
    case "setCompiledDil": {
      if (typeof msg.data.compiledDil !== "string") return false;
      const changed = session.message.compiledDil !== msg.data.compiledDil
                   || msg.data.dilComponents !== undefined;
      session.message.compiledDil = msg.data.compiledDil;
      if (msg.data.dilComponents !== undefined) session.message.dilComponents = msg.data.dilComponents;
      if (msg.data.data !== undefined)           session.message.data = msg.data.data;
      return changed;                       // ← 内容没变就不重渲染
    }
    case "setData":        session.message.data = msg.data.data; return false;
    case "setStateSnapshot": …;
  }
}
```

完整命令集（同一份词汇表）：

```text
createRunner, setCompiledDil, setData, setStateSnapshot, trigger,
invokeGlobal, invokeMessengerCommand, snapshot, lifecycle,
registerMessengerTransport, unregisterMessengerTransport
```

⇒ **服务端那 134 次整体重编译，就是 134 次 `setCompiledDil`**。iframe 只做转发 + 去重判断，真正 diff 的粒度在 Worker 里的自研渲染器（`renderSourceUpdate`）。

---

## 6. 生命周期与容错

| 机制 | 实现 |
|---|---|
| 启动预算 | `M = 4000ms`（整体）、`T = 500ms`（单次健康探测）、`X = 2`（启动重试次数） |
| generation 校验 | 每条消息带 `workerGeneration:sessionGeneration:startupAttempt`；`runnerId` / `activeRunnerId` / `documentBootId` 全对才处理，否则记 `stale_generation` 丢弃 |
| 健康探测 | `healthCheck` → `healthy`，检查 `workerGeneration / sessionGeneration / startupAttempt / documentBootId / runnerId` 是否**全部**匹配；页面隐藏时暂停计时器 |
| bfcache | `pagehide`（非 persisted）⇒ `channel.port1.close()` + `manager.dispose()`；`pageshow` / `freeze` / `resume` 全打点 |
| 旧会话回收 | `retiredDiagnosticSessions` 保留最近若干个（`we` 个 + `be` ms 超时），只为接收迟到诊断 |
| 失败隔离 | `quarantine` 状态：不再向 Worker 转发事件（`!session.quarantined && …`），直到有 `setCompiledDil` 触发 `recovery` |
| 首错归因 | `first_fault`：按优先级把 72 阶段压成一个"最可能的根因"（`runner_module_csp_enforced` / `runner_module_script_error` / `health_probe_expired` / `worker_execution` …） |
| 诊断限额 | 最多 64 条记录、`65536` / `8192` / `12288` 等字段长度上限（防诊断本身把页面拖死） |

---

## 7. 网络层证据（与结构对得上）

| 记录 | 请求 | 关键 header | 说明 |
|---|---|---|---|
| 2116 | `GET /deployments/dil/v14/runner.html` | `sec-fetch-site: none`、`sec-fetch-dest: document`、**无 `referer`** | 隔离 iframe 的文档导航，initiator origin 不透明 |
| 2124 | `GET /assets/dil/runner-C-vppISG.js` | `referer: …/deployments/dil/v14/runner.html`、`sec-fetch-site: same-origin` | iframe 内的 `<script type="module">` 加载 |
| 75 / 2126 | 同一 bundle | `origin: null`、`sec-fetch-site: cross-site` | **iframe 内 `fetch()` 发出的请求 ⇒ 文档 origin 是不透明的** |

最后一条是判定 sandbox 属性的关键：**`Origin: null` ⇒ iframe 没有 `allow-same-origin`**，也就是说它的 JS 运行在不透明源里 —— 拿不到 `localStorage`、拿不到宿主 DOM、也读不到自己 CDN 域下的任何数据。

> 补充：在另一个 chatgpt.com chunk（记录 146，`cdn/assets/203175.*.js`）里找到一个**通用 iframe 工厂**：
> ```js
> r.setAttribute("sandbox", "allow-scripts allow-same-origin");
> r.setAttribute("referrerpolicy", "no-referrer");
> r.setAttribute("partition", o);      // 存储分区
> ```
> 它是给"嵌入视图"类场景用的（还会往 shadowRoot 注入 `iframe { border-radius: inherit }`），**不等于 DIL runner 的属性**。DIL runner 的 sandbox 属性字符串没直接抓到，但从 `Origin: null` 可以确定它**没有** `allow-same-origin`。

---

## 8. 这套结构解决了什么

| 威胁 | 拦截层 |
|---|---|
| 模型代码把用户数据外发 | CSP `default-src 'none'`（连 `connect-src` 都没有）+ 全局白名单无 `fetch` |
| 模型代码读宿主 DOM / 偷 token | 跨域 iframe + 不透明 origin + Worker 无 `document` |
| 模型代码读写存储 | 不透明 origin（无 `localStorage`/`cookie`）+ `partition` |
| 注入额外脚本到 runner 文档 | `script-src` 用 SHA-256 哈希而非 `'unsafe-inline'`（CSP3 下哈希使 `unsafe-inline` 失效） |
| `<base>` 劫持相对路径 | `base-uri 'none'` |
| 无限递归嵌套 | `frame-src 'none'` |
| 死循环 / 卡死主线程 | Worker 线程 + 4s 启动预算 + 500ms 健康探测 + generation 校验 + quarantine |
| Worker blob URL 泄漏 | Worker 第一行 `revokeObjectURL(self.location.href)` |
| 静默失败（最常见） | 72 阶段诊断 + `first_fault` 归因 + `#dil-diagnostics=1` 按需开启 |

---

## 9. 还有个没解开的

**宿主侧创建这个 iframe 的代码没抓到。** 它应该在某个 chatgpt.com 的 `cdn/assets/*.js` chunk 里，构造形如：

```js
const url = `https://cdn.platform.openai.com/deployments/dil/v${PROTOCOL_VERSION}/runner.html${debug ? "#dil-diagnostics=1" : ""}`;
const frame = document.createElement("iframe");
frame.src = url;
frame.setAttribute("sandbox", ???);        // ← 想确认的正是这一行
// 然后监听 window "message"，收到 {kind:"ready"} 时取走 event.ports[0]
```

在抓包里 `deployments/dil` 只出现在 2124 的 `referer` 上，说明那个 loader chunk 要么被缓存（304 / memory cache）没进抓包，要么用了字符串拼接。

**想拿到它的话**：清掉 ChatGPT 页面的缓存后硬刷新（`Cmd+Shift+R`），或者开 DevTools 的 Network 面板筛 `dil`，然后把那条 chunk 请求对应的记录找出来。如果你能再抓一次，我可以把 sandbox 属性那一行补上。
