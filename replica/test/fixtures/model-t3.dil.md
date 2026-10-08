这是一份可交互的 MacBook 选购指南，您用三个问题加可选条件就能筛出最合适的机型。

<box gap="lg" padding="lg">
  <box gap="xs">
    <title>MacBook 选购指南</title>
    <text size="sm" color="secondary">回答三个问题，得到一个明确答案。以下为 M4 世代国行参考规格与价格，下单前请核对官网与教育优惠。</text>
  </box>

  <card padding="md" gap="md">
    <box gap="xs">
      <label>1 · 主要拿来干什么</label>
      <segmented-control value={purpose} onChange={setPurpose} options={[{"label":"上网办公","value":"office"},{"label":"编程开发","value":"code"},{"label":"视频剪辑","value":"media"},{"label":"3D / AI","value":"heavy"}]}/>
    </box>
    <box gap="xs">
      <label>2 · 多久带出门一次</label>
      <segmented-control value={mobility} onChange={setMobility} options={[{"label":"每天携带","value":"high"},{"label":"偶尔移动","value":"mid"},{"label":"基本固定","value":"desk"}]}/>
    </box>
    <box gap="xs">
      <label>3 · 预算上限（{fmt(budget)}）</label>
      <slider value={budget} onChange={setBudget} min={6000} max={36000} step={500}/>
    </box>
    <divider/>
    <box gap="sm">
      <caption color="secondary">额外条件</caption>
      <checkbox checked={extras.ram} onChange={(v)=>setExtras({...extras,ram:v})}>希望内存 24GB 以上</checkbox>
      <checkbox checked={extras.load} onChange={(v)=>setExtras({...extras,load:v})}>经常跑长时间导出 / 编译</checkbox>
      <checkbox checked={extras.two} onChange={(v)=>setExtras({...extras,two:v})}>要外接多台显示器</checkbox>
    </box>
  </card>

  <card padding="md" gap="md" background="raised">
    <row justify="space-between" align="center" gap="md" wrap>
      <box gap="xs">
        <caption color="accent">就是你 →</caption>
        <title size="lg">{best.name} · {best.chip}</title>
      </box>
      <badge color={over?"warning":"success"}>{fmt(best.price)}{over?" · 超预算":""}</badge>
    </row>
    <row gap="lg" wrap>
      <caption>内存 {best.ram}</caption>
      <caption>硬盘 {best.ssd}</caption>
      <caption>{best.inch}" 屏</caption>
      <caption>{best.kg} kg</caption>
      <caption>{best.note}</caption>
    </row>
    <divider/>
    {#each why as r}
      <row gap="md" align="start">
        <box><caption color="secondary">{r.k}</caption></box>
        <text size="sm">{r.v}</text>
      </row>
    {/each}
    <divider/>
    <row gap="sm" align="center">
      <icon name="info" size="sm" color="accent"/>
      <text size="sm">{advice}</text>
    </row>
  </card>

  <box gap="sm">
    <bold>候选对比</bold>
    <table>
      <table-row>
        <table-cell><caption>机型</caption></table-cell>
        <table-cell align="end"><caption>价格</caption></table-cell>
        <table-cell><caption>内存 / 硬盘</caption></table-cell>
        <table-cell align="end"><caption>重量</caption></table-cell>
        <table-cell align="end"><caption>匹配度</caption></table-cell>
      </table-row>
      {#each ranked as m}
        <table-row>
          <table-cell>{m.name} · {m.chip}{#if m.id === best.id} <badge color="accent">推荐</badge>{/if}</table-cell>
          <table-cell align="end" tabularNums>{fmt(m.price)}</table-cell>
          <table-cell>{m.ram} / {m.ssd}</table-cell>
          <table-cell align="end" tabularNums>{m.kg} kg</table-cell>
          <table-cell align="end" tabularNums>{m.s}</table-cell>
        </table-row>
      {/each}
    </table>
    <caption color="secondary">匹配度 = 用途契合 + 便携 + 预算的加权分，只用于横向比较。</caption>
  </box>

  <card padding="md">
    <Chart content={spec}/>
  </card>

  <box gap="sm">
    <bold>下单前避坑</bold>
    <list>
      <list-item><text size="sm">内存焊死在主板上，是唯一后期无法补救的部件，能加钱就一次到位。</text></list-item>
      <list-item><text size="sm">256GB 硬盘装完系统与几个大软件就紧张，512GB 是更舒服的起点。</text></list-item>
      <list-item><text size="sm">Air 无风扇，长时间导出/编译会降频；这类活直接上 Pro。</text></list-item>
      <list-item><text size="sm">不要买 Intel 芯片的旧款或第三方改装机。</text></list-item>
      <list-item><text size="sm">教育优惠与官方翻新常年便宜一档到两档内存，同预算优先换内存。</text></list-item>
      <list-item><text size="sm">Air 只有两个雷雳口，通勤记得配扩展坞。</text></list-item>
    </list>
  </box>
</box>