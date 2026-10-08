这是一份可交互的 MacBook 选购指南——先选用途，它会自动算出该加多少内存/硬盘、推荐哪台，并给出价格对比。

{@body const [usage,setUsage] = DIL.useState("office")}
{@body const [mobility,setMobility] = DIL.useState(true)}
{@body const [budget,setBudget] = DIL.useState(15000)}
{@body const USAGES = [{label:"日常办公",value:"office"},{label:"编程开发",value:"code"},{label:"视频剪辑",value:"video"},{label:"3D / 本地 AI",value:"ai"}]}
{@body const NEEDS = {office:{minRam:16,minSsd:256,pro:false,note:"M4 芯片对文档、网页、会议完全够用，唯一别省的是内存——16GB 起步，别买 8GB。"},code:{minRam:24,minSsd:512,pro:false,note:"Xcode、Docker、多开 IDE 很吃内存，24GB 更从容；编译速度上 M4 与 M4 Pro 差距没内存差距明显。"},video:{minRam:32,minSsd:1024,pro:true,note:"视频剪辑要 M4 Pro 起步（多编解码引擎 + 雷雳5），硬盘至少 1TB 当素材盘，外接硬盘做归档。"},ai:{minRam:48,minSsd:1024,pro:true,note:"本地跑大模型，内存就是模型能加载多大——48GB 是及格线，预算允许直接冲 64GB 以上。"}}
{@body const MODELS = [{name:"MacBook Air 13″",chip:"M4",price:7999,ram:16,ssd:256,weight:1.24,maxRam:32,maxSsd:2048,pro:false},{name:"MacBook Air 15″",chip:"M4",price:9999,ram:16,ssd:256,weight:1.51,maxRam:32,maxSsd:2048,pro:false},{name:"MacBook Pro 14″",chip:"M4",price:12999,ram:16,ssd:512,weight:1.55,maxRam:32,maxSsd:2048,pro:true},{name:"MacBook Pro 14″",chip:"M4 Pro",price:16999,ram:24,ssd:512,weight:1.60,maxRam:48,maxSsd:4096,pro:true},{name:"MacBook Pro 16″",chip:"M4 Pro",price:19999,ram:24,ssd:512,weight:2.14,maxRam:48,maxSsd:4096,pro:true},{name:"MacBook Pro 16″",chip:"M4 Max",price:27999,ram:36,ssd:1024,weight:2.14,maxRam:128,maxSsd:8192,pro:true}]}
{@body const RAM_P = {16:0,24:1500,32:3000,36:0,48:4500,64:6000,128:13500}}
{@body const SSD_P = {256:0,512:1500,1024:3000,2048:6000,4096:12000,8192:24000}}
{@body const need = NEEDS[usage]}
{@body const configs = MODELS.map(m=>{const ram=Math.max(m.ram,need.minRam);const ssd=Math.max(m.ssd,need.minSsd);const price=m.price+(RAM_P[ram]-RAM_P[m.ram])+(SSD_P[ssd]-SSD_P[m.ssd]);return {name:m.name,chip:m.chip,weight:m.weight,ram:ram,ssd:ssd,price:price,ok:ram<=m.maxRam&&ssd<=m.maxSsd&&(!need.pro||m.pro)&&(!mobility||m.weight<=1.75)}}).filter(c=>c.ok).sort((a,b)=>a.price-b.price)}
{@body const pick = configs[0] || null}
{@body const upgrade = configs[1] || null}
{@body const ssdText = n => n>=1024 ? (n/1024)+"TB" : n+"GB"}
{@body const rows = configs.slice(0,5).map(c=>({name:c.name.replace("MacBook ","")+" "+c.chip, price:c.price}))}
{@body const summary = pick ? `【推荐】${pick.name} ${pick.chip}｜内存 ${pick.ram}GB｜存储 ${ssdText(pick.ssd)}｜重量 ${pick.weight}kg｜约 ¥${pick.price.toLocaleString()}` : "没有匹配机型"}
{@body const used = pick ? Math.min(pick.price, budget) : 0}
<box gap={4}>
  <row justify="between" align="center">
    <title size="lg">MacBook 选购指南</title>
    <badge color="secondary">2025 款 · 价格约数</badge>
  </row>
  <caption>核心原则：**内存先加，硬盘后加**。内存焊死不可升级，硬盘可以外接。</caption>

  <segmented-control value={usage} onChange={setUsage} options={USAGES}/>
  <switch checked={mobility} onChange={setMobility}>经常背着出门（排除 2.1kg 的 16 寸）</switch>
  <slider label="预算上限（元）" value={budget} onChange={setBudget} min={7000} max={30000} step={500}/>

  <text color="info" size="sm">{need.note}</text>

  {#if pick}
  <card>
    <row justify="between" align="center">
      <box gap={0}>
        <caption>最划算的选择</caption>
        <title size="xl">{pick.name} · {pick.chip}</title>
      </box>
      <badge color={pick.price<=budget?"success":"warning"}>{pick.price<=budget ? "预算内" : "超预算"}</badge>
    </row>
    <divider/>
    <grid columns={3} gap={3}>
      <grid-item><box gap={0}><caption>内存</caption><text weight="bold" tabularNums>{pick.ram} GB</text></box></grid-item>
      <grid-item><box gap={0}><caption>存储</caption><text weight="bold" tabularNums>{ssdText(pick.ssd)}</text></box></grid-item>
      <grid-item><box gap={0}><caption>重量</caption><text weight="bold" tabularNums>{pick.weight} kg</text></box></grid-item>
    </grid>
    <row justify="between" align="center">
      <title size="lg" tabularNums>¥{pick.price.toLocaleString()}</title>
      <button variant="outline" size="sm" onClick={()=>GenUI.copy(summary)}>复制配置</button>
    </row>
  </card>
  <progress value={used} max={budget} label="占预算" showValue/>
  {:else}
  <card><row gap={2} align="center"><icon name="alert-triangle" color="warning"/><text>当前条件下没有合适的机型，放宽预算或关掉「便携」试试。</text></row></card>
  {/if}

  {#if upgrade}
  <row gap={2} align="center">
    <icon name="trending-up" color="info" size="sm"/>
    <text size="sm">多花 **¥{(upgrade.price-pick.price).toLocaleString()}** 可以升级到 {upgrade.name} {upgrade.chip}（{upgrade.ram}GB / {ssdText(upgrade.ssd)}）。</text>
  </row>
  {/if}

  <Chart content={{"chartType":"bar","xKey":"name","series":[{"dataKey":"price","label":"到手价","valuePrefix":"¥"}],"data":rows}}/>

  <table>
    <table-row header>
      <table-cell>机型</table-cell>
      <table-cell>芯片</table-cell>
      <table-cell align="end">内存</table-cell>
      <table-cell align="end">存储</table-cell>
      <table-cell align="end">重量</table-cell>
      <table-cell align="end">价格</table-cell>
    </table-row>
    {#each configs as c}
    <table-row>
      <table-cell>{c.name}</table-cell>
      <table-cell>{c.chip}</table-cell>
      <table-cell align="end">{c.ram}GB</table-cell>
      <table-cell align="end">{ssdText(c.ssd)}</table-cell>
      <table-cell align="end">{c.weight}kg</table-cell>
      <table-cell align="end">¥{c.price.toLocaleString()}</table-cell>
    </table-row>
    {/each}
  </table>
</box>

**三个容易踩的坑**

- **内存买小了**：Mac 的「统一内存」焊在主板上，买完无法升级，二手回收也只认原始配置。宁可硬盘小一点 + 挂个移动硬盘。
- **为用不到的性能买单**：纯文档 + 网页 + 视频会议，M4 和 M4 Max 的体感差异接近于零；预算优先花在内存上。
- **忽略接口与重量**：16 寸有 HDMI 和 SD 卡槽、散热更好，但 2.1kg 通勤真的重；Air 只有两个雷雳口，扩展坞基本是必需品。

价格按 Apple 官网常见配置估算，实际以官网选配页为准。