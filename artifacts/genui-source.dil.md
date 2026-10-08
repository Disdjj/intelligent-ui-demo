下面是一个完整的 **Intelligent UI 交互实验台**。它模拟一个 AI 产品的 Billing Control Center，包含三个可切换的工作区。所有数据均为虚构，交互计算在当前界面中完成，不会操作真实数据库或发起支付。

{@body const [tab,setTab] = DIL.useState("overview")}
{@body const [period,setPeriod] = DIL.useState("7")}
{@body const [channel,setChannel] = DIL.useState("all")}
{@body const [incident,setIncident] = DIL.useState(false)}
{@body const [model,setModel] = DIL.useState("balanced")}
{@body const [turns,setTurns] = DIL.useState(8000)}
{@body const [retry,setRetry] = DIL.useState(5)}
{@body const [rewards,setRewards] = DIL.useState(15)}
{@body const [wallet,setWallet] = DIL.useState(250)}
{@body const [ledger,setLedger] = DIL.useState([])}
{@body const [message,setMessage] = DIL.useState("")}
{@body const [search,setSearch] = DIL.useState("")}
{@body const [statusFilter,setStatusFilter] = DIL.useState("all")}
{@body const [riskOnly,setRiskOnly] = DIL.useState(false)}
{@body const [selectedAudit,setSelectedAudit] = DIL.useState("EVT-1042")}
{@body const money = (v) => "$"+Number(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}
{@body const number = (v) => Math.round(v).toLocaleString("en-US")}
{@body const channelFactor = {all:1,web:0.52,ios:0.31,android:0.17}[channel]}
{@body const n = period==="7"?7:period==="30"?10:12}
{@body const step = Number(period)/n}
{@body const swings = [-3,2,-1,3,0,4,-2,1,3,-1,2,4]}
{@body const trendData = Array.from({length:n},(_,i)=>({period:period==="7"?"D-"+(n-1-i):period==="30"?"P"+(i+1):"W"+(i+1),revenue:Math.round((2700+swings[i]*93)*step*channelFactor),cost:Math.round((960+swings[i]*29)*step*channelFactor*(incident&&i>=n-2?1.75:1))}))}
{@body const totalRevenue=trendData.reduce((a,b)=>a+b.revenue,0)}
{@body const totalCost=trendData.reduce((a,b)=>a+b.cost,0)}
{@body const marginPct=(totalRevenue-totalCost)/totalRevenue*100}
{@body const rates={fast:0.006,balanced:0.020,premium:0.055}}
{@body const modelLabels={fast:"Fast",balanced:"Balanced",premium:"Premium"}}
{@body const unitCost=rates[model]*(1+retry/100)}
{@body const creditsPerTurn=Number((unitCost*1000).toFixed(2))}
{@body const scenarioCost=turns*unitCost}
{@body const scenarioRevenue=turns*creditsPerTurn*0.004*(1-rewards/100)}
{@body const scenarioProfit=scenarioRevenue-scenarioCost}
{@body const scenarioMargin=scenarioRevenue>0?100*scenarioProfit/scenarioRevenue:0}
{@body const mockEvents=[{id:"EVT-1042",user:"user_4821",gateway:"PayCo",status:"pending",amount:120,time:"14:02:11",risk:true,note:"支付渠道已返回成功，权益发放事件尚未确认",trace:"trace-b7e2-1042"},{id:"EVT-1041",user:"user_1209",gateway:"App Store",status:"success",amount:3200,time:"13:59:48",risk:false,note:"订阅续期已完成，Credits 已到账",trace:"trace-a3c1-1041"},{id:"EVT-1040",user:"user_8812",gateway:"Google Play",status:"refunded",amount:-500,time:"13:55:16",risk:false,note:"退款完成，对应权益已冲正",trace:"trace-e8d1-1040"},{id:"EVT-1039",user:"user_2290",gateway:"PayCo",status:"failed",amount:800,time:"13:51:22",risk:true,note:"Webhook 签名校验失败，未写入钱包账本",trace:"trace-a8f0-1039"},{id:"EVT-1038",user:"user_1002",gateway:"Internal",status:"success",amount:-20,time:"13:50:08",risk:false,note:"LLM 调用完成，幂等扣费成功",trace:"trace-f3c4-1038"},{id:"EVT-1037",user:"user_9082",gateway:"Internal",status:"success",amount:100,time:"13:48:36",risk:false,note:"新用户邀请奖励发放",trace:"trace-c1f8-1037"}]}
{@body const events = incident?[{id:"EVT-1050",user:"user_4411",gateway:"Internal",status:"pending",amount:-44,time:"14:04:10",risk:true,note:"模拟重试风暴：模型调用重复产生 Usage Event，等待幂等检查",trace:"trace-incident-1050"},...mockEvents]:mockEvents}
{@body const filteredEvents=events.filter(e=>(statusFilter==="all"||e.status===statusFilter)&&(!riskOnly||e.risk)&&[e.id,e.user,e.gateway,e.trace].join(" ").toLowerCase().includes(search.toLowerCase()))}
{@body const selectedEvent=events.find(e=>e.id===selectedAudit)}
{@body const statusText={success:"已完成",pending:"待处理",failed:"失败",refunded:"已退款"}}
{@body function chargeOnce(){if(wallet<creditsPerTurn){setMessage("余额不足：无法完成本次试扣");return}const next=Number((wallet-creditsPerTurn).toFixed(2));setWallet(next);setLedger([{id:Date.now(),action:"模型推理扣费",delta:-creditsPerTurn,balance:next},...ledger].slice(0,7));setMessage("试扣成功：已写入模拟 Ledger")}}
{@body function recharge(){const next=Number((wallet+500).toFixed(2));setWallet(next);setLedger([{id:Date.now(),action:"模拟充值",delta:500,balance:next},...ledger].slice(0,7));setMessage("充值成功：已增加 500 Credits")}}
<box border radius="2xl" padding={3} gap={4}>
  <row align="center" justify="between" wrap="wrap">
    <row align="center" gap={2}>
      <box background="surface-secondary" padding={2} radius="lg">
        <icon name="layers-3" size="lg"/>
      </box>
      <box gap={1}>
        <title size="lg">Acme Billing</title>
        <caption>Interactive Control Center · Demo</caption>
      </box>
    </row>
    <row align="center" gap={2}>
      <badge color={incident?"warning":"success"}>{incident?"演练异常":"系统正常"}</badge>
      <text color="secondary" size="xs">Sandbox v1.0</text>
    </row>
  </row>
  <segmented-control block size="lg" value={tab} onChange={setTab} options={[{"label":"📊 运营总览","value":"overview"},{"label":"🧪 计费沙盒","value":"sandbox"},{"label":"🔎 交易审计","value":"audit"}]}/>
  {#if tab==="overview"}
    <row align="center" justify="between" wrap="wrap">
      <box gap={1}>
        <title size="lg">经营概览</title>
        <text size="xs" color="secondary">可交互模拟数据 · 视图间数据联动</text>
      </box>
      <row gap={2} wrap="wrap">
        <select size="md" value={channel} onChange={setChannel} options={[{"value":"all","label":"全部渠道"},{"value":"web","label":"Web"},{"value":"ios","label":"iOS"},{"value":"android","label":"Android"}]}/>
        <segmented-control size="md" value={period} onChange={setPeriod} options={[{"label":"7 天","value":"7"},{"label":"30 天","value":"30"},{"label":"90 天","value":"90"}]}/>
      </row>
    </row>
    <grid columns={2} gap={2}>
      <grid-item>
        <box border radius="lg" padding={3} gap={2}>
          <row align="center" justify="between">
            <text size="xs" color="secondary">模拟净收入</text>
            <icon name="wallet" color="secondary"/>
          </row>
          <title size="xl" color="default" tabularNums>{money(totalRevenue)}</title>
          <text color="success" size="xs"><icon name="trending-up" inline/> +12.4% 模拟环比</text>
        </box>
      </grid-item>
      <grid-item>
        <box border radius="lg" padding={3} gap={2}>
          <row align="center" justify="between">
            <text size="xs" color="secondary">模型成本</text>
            <icon name="cpu" color="secondary"/>
          </row>
          <title size="xl" tabularNums>{money(totalCost)}</title>
          <text color={incident?"danger":"secondary"} size="xs">{incident?"重试风暴增加成本":"占比 "+(100*totalCost/totalRevenue).toFixed(1)+"%"}</text>
        </box>
      </grid-item>
      <grid-item>
        <box border radius="lg" padding={3} gap={2}>
          <row align="center" justify="between">
            <text size="xs" color="secondary">模拟贡献毛利率</text>
            <icon name="chart-no-axes-combined" color="secondary"/>
          </row>
          <title size="xl" tabularNums>{marginPct.toFixed(1)}%</title>
          <text size="xs" color="secondary">不含固定开销与税费</text>
        </box>
      </grid-item>
      <grid-item>
        <box border radius="lg" padding={3} gap={2}>
          <row align="center" justify="between">
            <text size="xs" color="secondary">调用成功率</text>
            <icon name="activity" color="secondary"/>
          </row>
          <title size="xl" tabularNums>{incident?"97.30%":"99.52%"}</title>
          <text color={incident?"danger":"success"} size="xs">{incident?"低于 99% 阈值":"高于 99% 阈值"}</text>
        </box>
      </grid-item>
    </grid>
    <box border radius="lg" padding={3} gap={2}>
      <row align="center" justify="between">
        <box gap={1}>
          **营收与推理成本趋势**
          <text color="secondary" size="xs">按所选时间窗口聚合 · USD</text>
        </box>
        <icon name="chart-line" color="secondary"/>
      </row>
      <Chart content={{"chartType":"line","xKey":"period","series":[{"dataKey":"revenue","label":"收入","valuePrefix":"$"},{"dataKey":"cost","label":"模型成本","valuePrefix":"$"}],"data":trendData}}/>
    </box>
    <grid columns={2} gap={2}>
      <grid-item>
        <box border radius="lg" padding={3} gap={2}>
          **收入渠道结构**
          <text size="xs" color="secondary">按渠道分配的模拟收入</text>
          <Chart content={{"chartType":"bar","xKey":"name","series":[{"dataKey":"value","label":"营收","valuePrefix":"$"}],"data":[{"name":"Web","value":Math.round(2700*Number(period)*0.52)},{"name":"iOS","value":Math.round(2700*Number(period)*0.31)},{"name":"Android","value":Math.round(2700*Number(period)*0.17)}]}}/>
        </box>
      </grid-item>
      <grid-item>
        <box border radius="lg" padding={3} gap={3}>
          **可观测性信号**
          <box gap={3}>
            <box gap={1}>
              <row justify="between">
                <text color="secondary" size="xs">Webhook 延迟</text>
                <text weight="medium" size="xs">{incident?"8.2 s":"148 ms"}</text>
              </row>
              <box background="surface-tertiary" height="6px" radius="full" clip>
                <box background={incident?"#E58A42":"#16A085"} width={incident?"92%":"14%"} height="100%" radius="full"/>
              </box>
            </box>
            <box gap={1}>
              <row justify="between">
                <text color="secondary" size="xs">账本对账率</text>
                <text weight="medium" size="xs">{incident?"97.1%":"99.98%"}</text>
              </row>
              <box background="surface-tertiary" height="6px" radius="full" clip>
                <box background={incident?"#E58A42":"#16A085"} width={incident?"85%":"99.98%"} height="100%" radius="full"/>
              </box>
            </box>
            <box gap={1}>
              <row justify="between">
                <text color="secondary" size="xs">重复事件抑制率</text>
                <text weight="medium" size="xs">{incident?"94.0%":"99.99%"}</text>
              </row>
              <box background="surface-tertiary" height="6px" radius="full" clip>
                <box background={incident?"#E58A42":"#16A085"} width={incident?"80%":"99.99%"} height="100%" radius="full"/>
              </box>
            </box>
          </box>
          <button size="sm" color="secondary" variant="outline" block onClick={()=>setTab("audit")}>检查交易事件 <icon name="arrow-right" inline/></button>
        </box>
      </grid-item>
    </grid>
    <box border radius="lg" padding={3} gap={3}>
      <row align="start" justify="between" gap={3}>
        <row align="start" gap={2}>
          <icon name={incident?"alert-triangle":"shield-check"} color={incident?"danger":"success"} size="lg"/>
          <box flex="1" gap={1}>
            **故障注入实验**
            <text color="secondary" size="sm">{incident?"已注入模拟的 LLM 重试风暴。模型成本、成功率、延迟、对账率和审计事件均已变化。":"模拟 AI 请求链路出现重试风暴，观察多个业务组件如何同步响应。"}</text>
          </box>
        </row>
      </row>
      <button block color={incident?"secondary":"primary"} variant={incident?"outline":"solid"} onClick={()=>setIncident(!incident)}>
        <icon name={incident?"rotate-ccw":"zap"} inline/>
        {incident?"结束演练并恢复指标":"注入重试风暴"}
      </button>
    </box>
  {:else if tab==="sandbox"}
    <box gap={1}>
      <title size="lg">🧪 Credits 计费模拟器</title>
      <text size="sm" color="secondary">调整推理成本、重试概率和奖励消耗，观察单轮扣费及经营模型的变化。</text>
    </box>
    <box border radius="lg" padding={3} gap={3}>
      **推理配置**
      <box gap={1}>
        <label>推理模型档位</label>
        <radio-group direction="col" value={model} onChange={setModel}>
          <radio value="fast"><row justify="between" align="center"><text>Fast · 轻量</text><text color="secondary" size="sm">$0.006 / 轮</text></row></radio>
          <radio value="balanced"><row justify="between" align="center"><text>Balanced · 标准</text><text color="secondary" size="sm">$0.020 / 轮</text></row></radio>
          <radio value="premium"><row justify="between" align="center"><text>Premium · 高阶</text><text color="secondary" size="sm">$0.055 / 轮</text></row></radio>
        </radio-group>
      </box>
      <divider color="subtle"/>
      <box gap={2}>
        <row align="center" justify="between">
          <label>预计调用轮次</label>
          <text weight="medium" tabularNums>{number(turns)}</text>
        </row>
        <slider min={1000} max={50000} step={1000} value={turns} onChange={setTurns}/>
        <row justify="between">
          <caption>1,000</caption>
          <caption>50,000</caption>
        </row>
      </box>
      <box gap={2}>
        <row align="center" justify="between">
          <label>额外重试成本比例</label>
          <text weight="medium" tabularNums>{retry}%</text>
        </row>
        <slider min={0} max={40} step={1} value={retry} onChange={setRetry}/>
      </box>
      <box gap={2}>
        <row align="center" justify="between">
          <label>奖励 Credits 消费占比</label>
          <text weight="medium" tabularNums>{rewards}%</text>
        </row>
        <slider min={0} max={60} step={5} value={rewards} onChange={setRewards}/>
        <caption>用于模拟免费奖励带来的收入稀释，不代表真实会计收入确认方法。</caption>
      </box>
    </box>
    <grid columns={2} gap={2}>
      <grid-item>
        <box border radius="lg" padding={3} gap={1}>
          <text size="xs" color="secondary">每轮扣费</text>
          <title size="xl" tabularNums>{creditsPerTurn}</title>
          <caption>Credits</caption>
        </box>
      </grid-item>
      <grid-item>
        <box border radius="lg" padding={3} gap={1}>
          <text size="xs" color="secondary">预计模型总成本</text>
          <title size="xl" tabularNums>{money(scenarioCost)}</title>
          <caption>USD</caption>
        </box>
      </grid-item>
      <grid-item>
        <box border radius="lg" padding={3} gap={1}>
          <text size="xs" color="secondary">模拟对应收入</text>
          <title size="xl" tabularNums>{money(scenarioRevenue)}</title>
          <caption>以 $0.004 / Credits 估算</caption>
        </box>
      </grid-item>
      <grid-item>
        <box border radius="lg" padding={3} gap={1}>
          <text size="xs" color="secondary">预计贡献毛利率</text>
          <title size="xl" color={scenarioMargin<0?"danger":"default"} tabularNums>{scenarioMargin.toFixed(1)}%</title>
          <caption>不含支付手续费等</caption>
        </box>
      </grid-item>
    </grid>
    <box border radius="lg" padding={3} gap={2}>
      **情景经济模型**
      <Chart content={{"chartType":"bar","xKey":"item","series":[{"dataKey":"value","label":"USD","valuePrefix":"$"}],"data":[{"item":"模拟收入","value":Math.round(scenarioRevenue)},{"item":"模型成本","value":Math.round(scenarioCost)},{"item":"贡献毛利","value":Math.round(scenarioProfit)}]}}/>
      <text color="secondary" size="xs">扣费示例使用成本约 $0.001 / Credits 的换算假设。负贡献毛利反映为负值。</text>
    </box>
    <box border radius="lg" padding={3} gap={3}>
      <row justify="between" align="center">
        <box gap={1}>
          **模拟钱包与 Ledger**
          <text color="secondary" size="xs">执行真实的本地状态变化，而非静态按钮</text>
        </box>
        <icon name="database" color="secondary"/>
      </row>
      <box background="surface-secondary" radius="lg" padding={3} gap={1}>
        <caption>当前测试钱包余额</caption>
        <row align="baseline" gap={2}>
          <title size="2xl" tabularNums>{wallet.toFixed(2)}</title>
          <text color="secondary" size="sm">Credits</text>
        </row>
        <text color="secondary" size="xs">本次扣除 {creditsPerTurn.toFixed(2)} Credits</text>
      </box>
      <row gap={2}>
        <box flex="1">
          <button block onClick={chargeOnce}><icon name="minus-circle" inline/> 试扣一轮</button>
        </box>
        <box flex="1">
          <button block color="secondary" variant="outline" onClick={recharge}><icon name="plus-circle" inline/> 充值 500</button>
        </box>
      </row>
      {#if message!==""}
        <row align="center" gap={2}>
          <icon name="info" color="secondary"/>
          <text size="sm">{message}</text>
        </row>
      {/if}
      <divider color="subtle"/>
      <row align="center" justify="between">
        **本次模拟流水**
        <button size="xs" color="secondary" variant="ghost" onClick={()=>{setWallet(250);setLedger([]);setMessage("模拟钱包已重置")}}>重置</button>
      </row>
      {#if ledger.length===0}
        <box padding={4} align="center" gap={2}>
          <icon name="receipt-text" size="xl" color="tertiary"/>
          <text color="secondary" size="sm">暂无流水。点击试扣或充值开始。</text>
        </box>
      {:else}
        <table>
          <table-row>
            <table-cell width="45%"><text color="secondary" size="xs">事件</text></table-cell>
            <table-cell align="end"><text color="secondary" size="xs">变动</text></table-cell>
            <table-cell align="end"><text color="secondary" size="xs">余额</text></table-cell>
          </table-row>
          {#each ledger as item}
            <table-row>
              <table-cell><text size="sm">{item.action}</text></table-cell>
              <table-cell align="end"><text color={item.delta>0?"success":"default"} tabularNums>{item.delta>0?"+":""}{item.delta.toFixed(2)}</text></table-cell>
              <table-cell align="end"><text tabularNums>{item.balance.toFixed(2)}</text></table-cell>
            </table-row>
          {/each}
        </table>
      {/if}
    </box>
  {:else}
    <box gap={1}>
      <title size="lg">🔎 交易事件与审计</title>
      <text size="sm" color="secondary">搜索、筛选、异常定位与 Master–Detail 详情视图。</text>
    </box>
    <box border radius="lg" padding={3} gap={3}>
      <input value={search} onChange={setSearch} placeholder="搜索事件 ID、用户、支付渠道、Trace ID..."/>
      <row align="center" justify="between" wrap="wrap" gap={2}>
        <select size="md" value={statusFilter} onChange={setStatusFilter} options={[{"value":"all","label":"全部状态"},{"value":"success","label":"已完成"},{"value":"pending","label":"待处理"},{"value":"failed","label":"失败"},{"value":"refunded","label":"已退款"}]}/>
        <checkbox checked={riskOnly} onChange={setRiskOnly} lineThrough={false}>只看异常事件</checkbox>
      </row>
      <row align="center" justify="between">
        <text color="secondary" size="xs">筛选得到 {filteredEvents.length} 条模拟记录</text>
        <button variant="ghost" color="secondary" size="xs" onClick={()=>{setSearch("");setStatusFilter("all");setRiskOnly(false)}}><icon name="rotate-ccw" inline/> 清除筛选</button>
      </row>
      <table>
        <table-row>
          <table-cell><text weight="medium" size="xs">事件 ID</text></table-cell>
          <table-cell><text weight="medium" size="xs">渠道 / 状态</text></table-cell>
          <table-cell align="end"><text weight="medium" size="xs">操作</text></table-cell>
        </table-row>
        {#each filteredEvents as item}
          <table-row>
            <table-cell>
              <box gap={1}>
                <row align="center" gap={1}>
                  <text size="sm" weight="medium">{item.id}</text>
                  {#if item.risk}<icon name="alert-triangle" size="xs" color="danger"/>{/if}
                </row>
                <text color="secondary" size="xs">{item.user}</text>
              </box>
            </table-cell>
            <table-cell>
              <box gap={1}>
                <text size="sm">{item.gateway}</text>
                <text color={item.status==="success"?"success":item.status==="failed"?"danger":item.status==="pending"?"caution":"secondary"} size="xs">{statusText[item.status]}</text>
              </box>
            </table-cell>
            <table-cell align="end">
              <button size="xs" color={selectedAudit===item.id?"primary":"secondary"} variant={selectedAudit===item.id?"solid":"outline"} onClick={()=>setSelectedAudit(item.id)}>详情</button>
            </table-cell>
          </table-row>
        {/each}
      </table>
      {#if filteredEvents.length===0}
        <box padding={3} align="center" gap={2}>
          <icon name="search-x" size="lg" color="tertiary"/>
          <text size="sm" color="secondary">没有符合当前筛选条件的记录</text>
        </box>
      {/if}
    </box>
    {#if selectedEvent}
      <box border radius="lg" padding={3} gap={3}>
        <row align="center" justify="between">
          <box gap={1}>
            **事件详情**
            <text color="secondary" size="xs">{selectedEvent.id}</text>
          </box>
          <text color={selectedEvent.risk?"danger":"success"} size="xs" weight="medium">{selectedEvent.risk?"需要关注":"正常记录"}</text>
        </row>
        <table>
          {#each [{k:"User ID",v:selectedEvent.user},{k:"支付渠道",v:selectedEvent.gateway},{k:"处理状态",v:statusText[selectedEvent.status]},{k:"Credits 变动",v:String(selectedEvent.amount)},{k:"事件时间",v:selectedEvent.time},{k:"Trace ID",v:selectedEvent.trace}] as field}
            <table-row>
              <table-cell width="37%"><text color="secondary" size="sm">{field.k}</text></table-cell>
              <table-cell><text size="sm">{field.v}</text></table-cell>
            </table-row>
          {/each}
        </table>
        <box background="surface-secondary" padding={3} radius="md" gap={2}>
          <row gap={2} align="center">
            <icon name="file-search" color="secondary"/>
            **诊断信息**
          </row>
          <text size="sm">{selectedEvent.note}</text>
        </box>
        <row gap={2} wrap="wrap">
          <button size="md" block color="secondary" variant="outline" onClick={()=>GenUI.copy(selectedEvent.trace)}><icon name="copy" inline/> 复制 Trace ID</button>
        </row>
      </box>
    {/if}
    <box background="surface-secondary" radius="lg" padding={3} gap={2}>
      <row align="center" gap={2}>
        <icon name="workflow" color="secondary"/>
        **模拟审计链路**
      </row>
      <box gap={2} align="center">
        <box border background="surface" radius="md" padding={2} width="100%" align="center">
          <text size="sm" weight="medium">Provider Webhook / Usage Event</text>
        </box>
        <icon name="arrow-down" color="tertiary"/>
        <box border background="surface" radius="md" padding={2} width="100%" align="center">
          <text size="sm" weight="medium">Inbox → Idempotency → Ledger</text>
        </box>
        <icon name="arrow-down" color="tertiary"/>
        <box border background="surface" radius="md" padding={2} width="100%" align="center">
          <text size="sm" weight="medium">Entitlement → Reconciliation</text>
        </box>
      </box>
    </box>
  {/if}
  <divider color="subtle"/>
  <row justify="between" align="center" gap={2}>
    <text color="secondary" size="xs">Interactive demo · 所有状态仅存在于本次界面</text>
    <button size="xs" color="secondary" variant="ghost" onClick={()=>{setTab("overview");setPeriod("7");setChannel("all");setIncident(false);setModel("balanced");setTurns(8000);setRetry(5);setRewards(15);setWallet(250);setLedger([]);setMessage("");setSearch("");setStatusFilter("all");setRiskOnly(false);setSelectedAudit("EVT-1042")}}><icon name="refresh-cw" inline/> 全部重置</button>
  </row>
</box>

## 这个示例体现了什么？

它不只是把图表和表单拼在一起。你可以尝试三个操作：

1. **在运营总览注入重试风暴**：模型成本、成功率、延迟、对账率和审计事件会联动更新。
2. **在计费沙盒调整参数并试扣**：每轮 Credits 扣费、毛利预测、钱包余额与 Ledger 流水会产生对应变化。
3. **在交易审计中筛选异常**：搜索事件，查看诊断原因，复制关联的 Trace ID。

这里最值得注意的是：**界面的结构、交互控件、状态关系和数据可视化由我在回答中定义，ChatGPT 客户端负责渲染和执行支持的交互。**

它已经具备一个轻量交互式应用的体验，但尚不具备真正的服务端业务能力，例如数据库持久化、支付 API 调用和真实异步事件处理。

这也是 Intelligent UI 与传统 Markdown 回复的重要区别：它能够让一份回答从静态信息展示，升级为**可操作、可探索、可验证假设的交互式工作空间**。<MemoryCite />