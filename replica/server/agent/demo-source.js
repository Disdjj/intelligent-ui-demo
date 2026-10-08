'use strict';
/**
 * The scripted DIL source that the demo "agent" streams.
 *
 * This is the *output* of a model that has been taught the DIL dialect — exactly the
 * artifact we could never capture from the real system (its system prompt is injected
 * server-side). Written by hand here so the replica runs with zero API keys.
 *
 * Notice it is pure source: markdown prose + `{@body}` statements + JSX-like tags.
 * No imports, no components, no build step. The compiler turns it into JS.
 */

const DEMO_SOURCE = `下面是一个 **实验流量分配控制台**。它把灰度发布里最容易出错的三件事——分流比例、护栏指标、变更记录——放进同一个可交互的界面：数据全部为模拟数据，状态只存在于当前页面，不会调用任何真实发布系统。

{@body const [tab,setTab] = DIL.useState("overview")}
{@body const [env,setEnv] = DIL.useState("staging")}
{@body const [traffic,setTraffic] = DIL.useState(15)}
{@body const [guardrail,setGuardrail] = DIL.useState(true)}
{@body const [search,setSearch] = DIL.useState("")}
{@body const [applied,setApplied] = DIL.useState("")}
{@body const [runs,setRuns] = DIL.useState([
  {"id":"run-1041","env":"staging","pct":5,"by":"djj","status":"success","note":"基线对比"},
  {"id":"run-1042","env":"staging","pct":15,"by":"dji","status":"success","note":"放量 15%"},
  {"id":"run-1043","env":"prod","pct":2,"by":"ops","status":"failed","note":"护栏未通过，自动回滚"},
  {"id":"run-1044","env":"prod","pct":8,"by":"ops","status":"pending","note":"等待观察窗口"}
])}
{@body const envRate = {staging:0.42,prod:1.0,canary:0.18}[env]}
{@body const lift = (traffic*0.34*envRate).toFixed(2)}
{@body const risk = traffic>40||(env==="prod"&&!guardrail)}
{@body const riskPct = Math.min(99,Math.round(traffic*1.6+(guardrail?0:22)))}
{@body const series = [38,52,47,61,58,72,69].map((v,i)=>({"label":["一","二","三","四","五","六","日"][i],"value":Math.round(v*envRate)}))}
{@body const totalRuns = runs.length}
{@body const filtered = runs.filter(r=>[r.id,r.env,r.by,r.note].join(" ").toLowerCase().includes(search.toLowerCase()))}
{@body const statusText = {success:"已完成",pending:"观察中",failed:"已回滚"}}
{@body const statusColor = {success:"success",pending:"warning",failed:"danger"}}
{@body function applyRun(){setRuns([{"id":"run-"+Math.floor(1000+Math.random()*9000),"env":env,"pct":traffic,"by":"you","status":risk?"failed":"pending","note":risk?"护栏未通过，已拦截":"人工放量 "+traffic+"%"}].concat(runs));setApplied("已提交："+env+" / "+traffic+"%")}}

<box border radius="2xl" padding={4} gap={4}>
  <row align="center" justify="between" wrap>
    <row align="center" gap={3}>
      <box background="sunken" padding={2}><icon name="beaker" size="lg"/></box>
      <column gap={1}>
        <title size="lg">Experiment Console</title>
        <caption>Traffic Allocation · Sandbox</caption>
      </column>
    </row>
    <row align="center" gap={2}>
      <badge color={risk?"danger":"success"}>{risk?"护栏告警":"运行正常"}</badge>
      <text size="xs" color="secondary">mock data</text>
    </row>
  </row>

  <segmented-control block value={tab} onChange={setTab} options={[{"label":"📊 概览","value":"overview"},{"label":"🎚 分配","value":"allocation"},{"label":"🗂 记录","value":"runs"}]}/>

  {#if tab==="overview"}
    <grid columns={4}>
      <grid-item><box border radius="lg" padding={3}><text size="xs" color="secondary">当前放量</text><title size="xl">{traffic}%</title></box></grid-item>
      <grid-item><box border radius="lg" padding={3}><text size="xs" color="secondary">预计提升</text><title size="xl">+{lift}%</title></box></grid-item>
      <grid-item><box border radius="lg" padding={3}><text size="xs" color="secondary">实验次数</text><title size="xl">{totalRuns}</title></box></grid-item>
      <grid-item><box border radius="lg" padding={3}><text size="xs" color="secondary">风险分</text><title size="xl" color={risk?"danger":"default"}>{riskPct}</title></box></grid-item>
    </grid>
    <box border radius="lg" padding={3} gap={2}>
      <text size="sm" weight="medium">近 7 日命中量（{env}）</text>
      <chart data={series} height={160} color={risk?"danger":"accent"}/>
    </box>
    <progress value={traffic} max={100} label={"灰度覆盖 "+traffic+"%"}/>
  {/if}

  {#if tab==="allocation"}
    <box border radius="lg" padding={3} gap={3}>
      <row align="center" justify="between" wrap>
        <text size="sm" weight="medium">目标环境</text>
        <select value={env} onChange={setEnv} options={[{"label":"staging","value":"staging"},{"label":"canary","value":"canary"},{"label":"prod","value":"prod"}]}/>
      </row>
      <slider value={traffic} min={0} max={100} step={5} label={"放量比例 "+traffic+"%"} onChange={setTraffic}/>
      <checkbox checked={guardrail} onChange={setGuardrail}>启用护栏自动回滚（错误率 > 1% 立即回滚）</checkbox>
      {#if risk}
        <row align="center" gap={2}><icon name="alert-triangle" color="danger"/><text size="sm" color="danger">当前组合会触发护栏：生产环境未开自动回滚，或放量超过 40%。</text></row>
      {:else}
        <row align="center" gap={2}><icon name="check-circle" color="success"/><text size="sm" color="success">组合安全，可以提交。</text></row>
      {/if}
      <row gap={2}>
        <button onClick={applyRun} disabled={risk}>提交放量方案</button>
        <button variant="outline" onClick={()=>{setTraffic(5);setGuardrail(true);setEnv("staging");setApplied("")}}>重置</button>
      </row>
      {#if applied!==""}
        <text size="xs" color="secondary">{applied}</text>
      {/if}
    </box>
  {/if}

  {#if tab==="runs"}
    <box border radius="lg" padding={3} gap={3}>
      <input value={search} onChange={setSearch} placeholder="搜索 run id / 环境 / 操作人..."/>
      <text size="xs" color="secondary">筛选到 {filtered.length} 条记录</text>
      <table>
        <table-row>
          <table-cell><text size="xs" weight="medium">RUN</text></table-cell>
          <table-cell><text size="xs" weight="medium">环境</text></table-cell>
          <table-cell align="end"><text size="xs" weight="medium">放量</text></table-cell>
          <table-cell align="end"><text size="xs" weight="medium">状态</text></table-cell>
        </table-row>
        {#each filtered as run}
          <table-row>
            <table-cell><bold>{run.id}</bold><caption>{run.note}</caption></table-cell>
            <table-cell><text size="sm">{run.env}</text></table-cell>
            <table-cell align="end"><text size="sm" tabularNums>{run.pct}%</text></table-cell>
            <table-cell align="end"><badge color={statusColor[run.status]}>{statusText[run.status]}</badge></table-cell>
          </table-row>
        {/each}
      </table>
      {#if filtered.length===0}
        <text size="sm" color="secondary">没有符合当前筛选条件的记录。</text>
      {/if}
    </box>
  {/if}

  <divider/>
  <row align="center" justify="between" wrap>
    <text size="xs" color="secondary">界面的结构、控件与联动逻辑由模型在回答中定义，客户端负责渲染与执行。</text>
    <text size="xs" color="tertiary">Interactive demo</text>
  </row>
</box>

## 这个示例演示了什么？

1. **一次回答就是一个应用**：三个工作区、四个派生指标、一张图表、一张可筛选的表格，全部来自上面的源码。
2. **状态是回答的一部分**：切换标签、拖动放量、搜索记录都发生在本地，不会请求服务端。
3. **降级路径是内建的**：如果执行环境不可用，这段回答会退化成一版结构完整的 Markdown。

这也是 Intelligent UI 与普通 Markdown 的分界线：回答从"可读"变成"可操作"。`;

module.exports = { DEMO_SOURCE };
