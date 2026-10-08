# Intelligent UI Demo

拆解 ChatGPT「Intelligent UI」（内部代号 DIL / GenUI）的实现方式，并给出一个可运行的复刻。

- 📝 **[BLOG.zh-CN.md](BLOG.zh-CN.md)**：完整的实现解析，以及与 [AG-UI](https://docs.ag-ui.com/)、[A2UI](https://a2ui.org/) 的对照
- 🔬 **[ANALYSIS.md](ANALYSIS.md)** / **[RUNNER-SANDBOX.md](RUNNER-SANDBOX.md)** / **[ARTICLE.md](ARTICLE.md)**：逐条抓包证据的分析笔记
- 🛠 **[replica/](replica/)**：复刻实现：流式 DSL 编译器、iframe + Worker 沙箱、宿主渲染器、状态回环

## 快速开始

```bash
cd replica
npm install
npm start      # mock agent：回放抓包里的原始源码，不需要任何密钥
npm test       # 98 个测试
```

打开 http://127.0.0.1:8787/ 。接入真实模型（任意 OpenAI 兼容接口）见 [replica/README.md](replica/README.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `artifacts/` | 一次完整生成的产物：模型写的 DIL 源码、编译后的 JS、常量池、降级 Markdown |
| `captures/` | 协议记录：流式补丁、最终会话状态、`view_state` 上报 |
| `replica/` | 复刻实现（Node ≥ 22，零运行时依赖） |
| `scripts/sanitize-capture.py` | 抓包脱敏脚本 |

## 关于抓包数据

- **已脱敏。** 认证、cookie、账号、设备相关的请求头已替换为 `<redacted>`；会话、消息等 id 映射为稳定的假 UUID；IP 与 token 已清除。
- **产品名为化名。** 原始回答里出现的真实产品名替换为同长度的化名（Acme / Credits / PayCo），因此抓包里所有源码偏移量（`genui_components` 区间、诊断行列号）仍然准确。
- **不包含 OpenAI 的运行时代码。** runner bundle、iframe 文档、宿主 chunk 没有随仓库分发，分析文档只引用了必要片段。

## 声明

本项目是出于学习目的的独立研究，与 OpenAI 无关，也未获其认可。「ChatGPT」是 OpenAI 的商标。抓包来自作者本人账号的一次正常使用。
