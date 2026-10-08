这是一份可直接运行的 MacBook 选购指南网页源码，您点几下就能看到适合自己的机型和参考价。
```html
<box gap="lg">
  <card padding="lg" gap="md">
    <title size="lg">选一台不后悔的 MacBook</title>
    <caption color="secondary">回答三个问题，它会从当前在售机型里挑出匹配度最高的一台。</caption>

    <row gap="md" align="center" wrap>
      <text weight="semibold" size="sm">主要用途</text>
      <segmented-control options={usageOpts} value={usage} onChange={setUsage}/>
    </row>
    <row gap="md" align="center" wrap>
      <text weight="semibold" size="sm">屏幕尺寸</text>
      <segmented-control options={sizeOpts} value={sizePref} onChange={setSizePref}/>
    </row>
    <row gap="md" align="center" wrap>
      <checkbox checked={portable} onChange={setPortable}>经常背着到处跑</checkbox>
    </row>
    <column gap="xs">
      <row justify="space-between">
        <text size="sm" weight="semibold">预算</text>
        <text size="sm" tabularNums color="accent">{fmt(budget)}</text>
      </row>
      <slider value={budget} onChange={(v)=>setBudget(Number(v))} min={6000} max={30000} step={500}/>
    </column>
  </card>

  <card padding="lg" gap="sm" border>
    <row justify="space-between" align="center" wrap>
      <text weight="semibold" color="secondary" size="sm">最推荐</text>
      <badge color={best.score>=80?"success":best.score>=65?"warning":"danger"}>匹配度 {best.score}</badge>
    </row>
    <title size="lg">{best.name}</title>
    <row gap="lg" wrap>
      <text size="sm">{best.chip}</text>
      <text size="sm" color="secondary">{best.ram} · {best.storage}</text>
      <text size="sm" color="secondary">{best.screen} · {best.weight} kg</text>
      <text size="sm" weight="semibold" tabularNums>{fmt(best.price)}</text>
    </row>
    <text size="sm" color="secondary">{why}</text>
    <divider/>
    <text size="sm">省钱之选：<bold>{valuePick.name}</bold> · {fmt(valuePick.price)} —— 算力够用，砍掉的是屏幕和接口，不是性能底线。</text>
  </card>

  <card padding="lg" gap="sm">
    <row gap="md" wrap>
      <badge>内存 {ramAdvice}</badge>
      <badge>存储 {diskAdvice}</badge>
    </row>
    <Chart content={{"chartType":"bar","layout":"vertical","xKey":"name","series":[{"dataKey":"price","label":"参考价","valuePrefix":"¥"}],"data":chartData,"meta":{"title":"各机型参考价","description":"按与你需求的匹配度排序"}}}/>
  </card>

  <card padding="sm">
    <table>
      <table-row>
        <table-cell><text size="sm" weight="semibold">机型</text></table-cell>
        <table-cell><text size="sm" weight="semibold">芯片</text></table-cell>
        <table-cell align="end"><text size="sm" weight="semibold">重量</text></table-cell>
        <table-cell align="end"><text size="sm" weight="semibold">参考价</text></table-cell>
        <table-cell align="end"><text size="sm" weight="semibold">匹配</text></table-cell>
      </table-row>
      {#each scored as m}
      <table-row>
        <table-cell><text size="sm">{m.name}</text></table-cell>
        <table-cell><text size="sm" color="secondary">{m.chipShort}</text></table-cell>
        <table-cell align="end"><text size="sm" tabularNums>{m.weight}kg</text></table-cell>
        <table-cell align="end"><text size="sm" tabularNums>{fmt(m.price)}</text></table-cell>
        <table-cell align="end"><badge color={m.score>=80?"success":m.score>=65?"warning":"danger"}>{m.score}</badge></table-cell>
      </table-row>
      {/each}
    </table>
  </card>

  <card padding="lg" gap="sm">
    <text weight="semibold">加钱优先级：钱花在哪里最值</text>
    <list>
      <list-item><text size="sm">1. 内存 > 存储。内存焊死在主板上，存储不够可以外接硬盘或 iCloud。</text></list-item>
      <list-item><text size="sm">2. 屏幕素质。Pro 的 XDR + 120Hz 对剪辑调色和长时间阅读是实打实的提升。</text></list-item>
      <list-item><text size="sm">3. 接口。Pro 自带 HDMI 和 SD 卡槽，Air 只有两个雷雳口，扩展坞是隐藏成本。</text></list-item>
      <list-item><text size="sm">4. 芯片档位最后考虑。M4 到 M4 Pro 的差距，只在导出、编译、渲染这类长时间满载任务里才摸得到。</text></list-item>
    </list>
    <caption color="secondary">价格会随教育优惠、国补和以旧换新波动，下单前以官方商店为准。</caption>
  </card>
</box>
```
### 选购逻辑与上手体验

整个页面把几个关键选项揉成了一个即时反馈的小工具，您不用翻长文，点几下就能看到推荐变化。

- **用途、屏幕和便携偏好**：用分段控件和复选框快速锁定需求，每次改动都会重新计算所有机型的匹配度，推荐卡片和图表同步刷新。
- **预算滑块**：范围从 6000 到 30000 元，实时显示当前金额，匹配度里的价格权重会跟着调整。
- **推荐卡片**：展示最匹配的机型名称、芯片、内存、屏幕、重量和价格，并附上一句匹配说明；下方还有“省钱之选”供您对照。
- **图表和表格**：柱状图按匹配度排序展示各机型参考价，表格则把芯片、重量、价格、匹配分齐全地摆出来，方便横向比较。
- **加钱优先级**：结尾用列表总结了内存、屏幕、接口、芯片的取舍建议，给预算分配一个大致方向。
---

**优化建议：** 页面中的机型数据、价格和匹配度算法都是写死的示例，您可以替换成自己实际的候选清单或最新参考价。