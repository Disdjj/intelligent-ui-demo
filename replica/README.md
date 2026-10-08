# Intelligent UI Replica

一个可运行的 ChatGPT「Intelligent UI」（DIL / GenUI）复刻：模型只输出 DIL 源码，服务端边收边编译，浏览器在 iframe + Worker 双层沙箱里执行，宿主渲染器把元素树画成界面；用户在界面上的操作会上报回服务端，下一轮对话交给模型。

逆向分析见仓库根目录的 `BLOG.zh-CN.md`、`ANALYSIS.md`、`RUNNER-SANDBOX.md`；抓包产物在 `../artifacts/`、`../captures/`，测试直接拿它们做对照。

## 运行

```bash
npm install                     # 仅 linkedom，供测试用
npm start                       # mock agent，无需密钥
npm test                        # 98 个测试

# 接真实模型（任意 OpenAI 兼容接口）
DIL_LLM_BASE_URL=https://api.deepseek.com \
DIL_LLM_API_KEY=sk-... \
DIL_LLM_MODEL=deepseek-flash \
DIL_LLM_THINKING=off \
npm start
```

需要 Node ≥ 22（测试通过 `require()` 加载浏览器端的 ES 模块）。全部环境变量见 `server/config.js`。

| 地址 | 内容 |
|---|---|
| `/` | 聊天页。右上角 `</>` 打开开发者面板，可查看每一轮的协议、源码、编译产物、组件通道、视图状态 |
| `/embed` | `<dil-embed>` 自定义元素示例 |
| `/diag` | 沙箱自检（不走模型） |

## 管线

```
agent ──source chunks──► compiler ──{p,o,v} patches (SSE)──► browser
                          │                                    │
                          │ parse → markdown → statements      ├─ stream.js       patch → message model
                          │ → codegen → fallback               ├─ sandbox.js      iframe ⇄ Worker
                          │ → genui_components                 ├─ renderer/       tree → DOM
                          │                                    └─ view-state.js   keyed state → POST
                          └──────── genui_state_snapshots ◄── view_state store ◄──┘
```

## 目录

```
server/
  index.js              路由（只有路由）
  config.js             全部环境变量
  http/chat.js          GET /api/chat：一轮对话 → 流式补丁
  http/respond.js       JSON / 静态文件 / 读 body
  view-state.js         /dil/view_state 存储 + 回灌上下文
  agent/                mock（回放）与 llm（OpenAI 兼容流式）、系统提示词、示例源码
  compiler/
    index.js            compile()：串起下面各步
    scanner.js          括号匹配、顶层分隔符、码点下标
    parser.js           源码 → AST + 恢复诊断（从不抛错）；<code>/<pre> 按纯文本解析
    repair.js           修复模型常见错误：未声明的受控状态、```html 围栏
    validate.js         逐片段语法校验，坏片段替换为安全值，保证程序整体可解析
    markdown.js         正文 → title / text / list 元素
    statements.js       {@body}：useState 语义键、__dilSafe 包装
    codegen.js          AST → __dil.jsx(...) + 常量池
    components.js       组件分类、<Chart> shim、resolution id
    fallback.js         降级 Markdown
    genui-components.js 组件源码区间与流式补丁
  sandbox/frame.js      生成 /sandbox/runner.html（CSP + 启动探针）
sandbox/worker.js       沙箱内的 React-like 运行时
public/
  dil/                  可复用的客户端库（ES 模块）
    message-view.js     一条消息：流 + 沙箱 + 视图
    sandbox.js  stream.js  view-state.js  embed.js
    renderer/           index.js · patch.js · icons.js · components/*
    dil.css             组件样式与设计 token（随系统亮/暗）
  app/                  聊天页：main.js · turn.js · devpanel.js · app.css
tools/                  node 沙箱、DOM harness、编译 CLI、浏览器检查
test/                   编译器 / 运行时 / 集成 / 抓包对照 / 视图状态
```

## 健壮性

`test/robustness.test.js` 用曾经出错的真实模型输出（`test/fixtures/`）做性质测试：**每一个流式前缀**编译出的程序都必须可解析，并且送进同一个沙箱持续更新时不能失败。一处写错只会让对应的元素消失，不会让整个界面空白。

## 与抓包对照的不变量

`test/artifact.test.js` 用真实抓包源码验证：

- 编译零诊断；15 个 `useState` 键与 `view_state` 请求体完全一致
- `genui_components` 的 4 组源码区间与抓包逐字相同（按 Unicode 码点计）
- `<Chart content>` 降级为内建图表，`<MemoryCite>` 经 `componentResults` 解析
- 三个工作区都能切换，按钮、单选、滑块往返沙箱正常
