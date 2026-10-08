这是一个可交互的 Go 高并发原理演示台，选主题、拖滑块就能看到调度队列、缓冲区水位和吞吐量的实时变化。

{@body const [topic,setTopic] = DIL.useState("gmp")}
{@body const TOPICS = [{label:"GMP 调度器",value:"gmp"},{label:"Channel 语义",value:"ch"},{label:"同步原语",value:"sync"},{label:"工作池",value:"pool"}]}
{@body const SUMMARY = {gmp:"G 是任务、M 是线程、P 是执行许可；调度的本质是在 P 之间搬运 G，并用抢占与 netpoller 避免线程被浪费。",ch:"无缓冲是同步握手，有缓冲是异步队列；吞吐永远由较慢的那一端决定。",sync:"读多写少用 RWMutex，计数器用 atomic，其余场景 Mutex 就够——先测量再优化。",pool:"限流不是限制能力，而是把不可控的并发变成可预测的并发。"}}
{@body const summary = SUMMARY[topic]}
{@body const [procs,setProcs] = DIL.useState(4)}
{@body const [gs,setGs] = DIL.useState(40)}
{@body const perP = Math.floor(gs/procs)}
{@body const rem = gs % procs}
{@body const queues = Array.from({length:procs},(_,i)=>perP+(i<rem?1:0))}
{@body const qRows = queues.map((n,i)=>({name:"P"+i, pending:n}))}
{@body const qMax = Math.max(...queues,1)}
{@body const [buf,setBuf] = DIL.useState(3)}
{@body const [prod,setProd] = DIL.useState(6)}
{@body const [cons,setCons] = DIL.useState(4)}
{@body const diff = prod-cons}
{@body const fill = diff>0 ? (buf/diff).toFixed(1) : "-"}
{@body const [readRatio,setReadRatio] = DIL.useState(80)}
{@body const [conc,setConc] = DIL.useState(16)}
{@body const rN = readRatio}
{@body const wN = 100-readRatio}
{@body const readPar = Math.max(1,Math.min(conc,8))}
{@body const mutexT = rN + wN*3}
{@body const rwT = Math.max(1, wN*3 + rN/readPar)}
{@body const atomicT = Math.max(1, wN*3 + rN*0.2)}
{@body const syncRows = [{name:"Mutex", ms:Math.round(mutexT)},{name:"RWMutex", ms:Math.round(rwT)},{name:"atomic", ms:Math.round(atomicT)}]}
{@body const best = syncRows.reduce((a,b)=>a.ms<b.ms?a:b).name}
{@body const [tasks,setTasks] = DIL.useState(200)}
{@body const [workers,setWorkers] = DIL.useState(8)}
{@body const [cost,setCost] = DIL.useState(20)}
{@body const serialT = tasks*cost}
{@body const paraT = Math.ceil(tasks/workers)*cost}
{@body const speedup = (serialT/paraT).toFixed(2)}
{@body const POOLW = [1,2,4,8,16,32]}
{@body const poolRows = POOLW.map(w=>({name:w+" 协程", ms:Math.ceil(tasks/w)*cost}))}
<box gap={4}>
  <row justify="between" align="center">
    <title size="xl">Go 高并发系统原理</title>
    <badge color="info">Goroutine · GMP · Channel</badge>
  </row>
  <segmented-control value={topic} onChange={setTopic} options={TOPICS}/>

  {#if topic === "gmp"}
    <card gap={3}>
      <title size="md">G — M — P 三角关系</title>
      <text>**G** 是待执行的 Goroutine，**M** 是内核线程，**P** 是调度上下文，持有本地运行队列。M 必须绑定一个 P 才能执行 G；P 的数量由 `GOMAXPROCS` 决定，默认等于 CPU 核数。**所以真正的并行度上限是 P 的数量，不是 goroutine 的数量。**</text>
      <slider label="P 的数量 (GOMAXPROCS)" value={procs} onChange={setProcs} min={1} max={8}/>
      <slider label="就绪状态的 Goroutine 数" value={gs} onChange={setGs} min={1} max={200}/>
    </card>
    <grid columns={4} gap={2}>
      {#each qRows as q}
        <grid-item>
          <card padding={3}>
            <row justify="between"><bold>{q.name}</bold><caption>{q.pending} 个 G</caption></row>
            <progress value={q.pending} max={qMax} showValue={false}/>
          </card>
        </grid-item>
      {/each}
    </grid>
    <Chart content={{"chartType":"bar","xKey":"name","series":[{"dataKey":"pending","label":"本地队列长度"}],"data":qRows}}/>
    <card gap={2} background="sunken">
      <bold>调度器的六个关键动作</bold>
      <list>
        <list-item>每个 P 有 **本地队列（上限 256）**，入队出队无锁，是最快路径。</list-item>
        <list-item>本地队列满 → `runqputslow` 把一半 G 挪进 **全局队列**，加锁但摊薄成本。</list-item>
        <list-item>本地队列空 → 先查全局队列，再 **work stealing**：从别的 P 偷一半过来。</list-item>
        <list-item>G 发起阻塞系统调用 → M 与 P 解绑，P 立刻交给空闲 M 或新建一个 M 顶上。</list-item>
        <list-item>网络 I/O 由 **netpoller** 接管，G 挂起但不占用 M，就绪后重新入队。</list-item>
        <list-item>`sysmon` 约每 **10ms** 做一次抢占检查，防止死循环的 G 饿死其它 G。</list-item>
      </list>
    </card>

  {:else if topic === "ch"}
    <card gap={3}>
      <title size="md">Channel：同步点还是管道？</title>
      <text>底层结构是 `hchan`：环形缓冲 `buf`、发送等待队列 `sendq`、接收等待队列 `recvq`。**当 recvq 里已有 goroutine 在等，发送者直接把数据拷给它，绕过缓冲区**——这是快路径。</text>
      <slider label="缓冲区容量 make(chan T, n)" value={buf} onChange={setBuf} min={0} max={16}/>
      <slider label="生产者 goroutine 数" value={prod} onChange={setProd} min={1} max={16}/>
      <slider label="消费者 goroutine 数" value={cons} onChange={setCons} min={1} max={16}/>
    </card>
    <row gap={3} wrap>
      <badge color={buf===0?"warning":"info"}>{buf===0?"无缓冲：同步交接":"有缓冲：异步队列"}</badge>
      <badge color="secondary">稳态吞吐 = min(生产, 消费) = {Math.min(prod,cons)} 单位/时间</badge>
      <badge color="secondary">缓冲区 {buf} 格</badge>
    </row>
    <card gap={2}>
      {#if diff > 0}
        <text color="warning">生产快于消费：缓冲区约 **{fill}** 个时间单位后被填满，之后 send 阻塞、生产者挂进 sendq。</text>
      {:else if diff === 0}
        <text color="success">生产与消费速率相等：缓冲区水位在 0 附近抖动，不会持续积压，这是最理想的稳态。</text>
      {:else}
        <text color="info">消费快于生产：消费者频繁空转，recv 阻塞在 recvq 上，系统吞吐被生产者卡住。**加消费者没用，要加生产者或合并批次。**</text>
      {/if}
    </card>
    <table>
      <table-row header><table-cell>容量</table-cell><table-cell>语义</table-cell><table-cell>阻塞条件</table-cell></table-row>
      <table-row><table-cell>0</table-cell><table-cell>同步交接，收发握手即完成</table-cell><table-cell>双方必须同时就绪</table-cell></table-row>
      <table-row><table-cell>n</table-cell><table-cell>环形缓冲，解耦快慢两端</table-cell><table-cell>满时 send 阻塞，空时 recv 阻塞</table-cell></table-row>
    </table>
    <text color="secondary">关闭后：receive 立即返回零值且 `ok=false`；向已关闭的 channel 发送会 **panic**；nil channel 永久阻塞，常用来在 select 里动态摘除分支。</text>

  {:else if topic === "sync"}
    <card gap={3}>
      <title size="md">选对同步原语，比调参更重要</title>
      <text>把 100 次操作按读写比例混合，估算三种方案的相对耗时。**读多写少时 RWMutex 收益最大；写多读少时 Mutex 反而更划算**，因为 RWMutex 内部的计数器与唤醒逻辑本身也有成本。</text>
      <slider label="读操作占比 %" value={readRatio} onChange={setReadRatio} min={0} max={100} step={5}/>
      <slider label="并发 goroutine 数" value={conc} onChange={setConc} min={1} max={64}/>
    </card>
    <Chart content={{"chartType":"bar","xKey":"name","series":[{"dataKey":"ms","label":"完成 100 次操作的相对耗时"}],"data":syncRows}}/>
    <row gap={3} wrap>
      <badge color="secondary">读并发上限 = {readPar}（受核数约束）</badge>
      <badge color="success">当前最优：{best}</badge>
      <badge color="info">读 {rN} / 写 {wN}</badge>
    </row>
    <card gap={2} background="sunken">
      <bold>各自的主场</bold>
      <list>
        <list-item>`atomic`：无锁 CAS，适合计数器、标志位、指针替换，最便宜但只覆盖简单操作。</list-item>
        <list-item>`Mutex`：正常模式先自旋几次再休眠；等待超过 1ms 进入 **饥饿模式**，改为 FIFO 直接交接，避免尾部延迟毛刺。</list-item>
        <list-item>`RWMutex`：读共享写独占，写者优先以防写饥饿；**不可重入**，读到一半再取写锁会死锁。</list-item>
        <list-item>`WaitGroup`：计数器加信号量，`Add` 必须在 `Wait` 之前完成。</list-item>
        <list-item>`sync.Pool`：对象复用，缓解 GC 压力，但对象随时可能被清空，不能当缓存用。</list-item>
      </list>
    </card>

  {:else}
    <card gap={3}>
      <title size="md">工作池：把十万个 goroutine 收进 8 个</title>
      <text>每个请求都 `go func()` 在流量高峰会瞬间产生海量 G，栈内存、调度压力和 GC 一起爆掉。**固定大小的 worker pool 用 channel 当任务队列**，把并发度钉死在可控区间。</text>
      <slider label="任务总数" value={tasks} onChange={setTasks} min={20} max={1000} step={20}/>
      <slider label="worker 协程数" value={workers} onChange={setWorkers} min={1} max={32}/>
      <slider label="单任务耗时 (ms)" value={cost} onChange={setCost} min={1} max={100}/>
    </card>
    <row gap={3} wrap>
      <card><caption>串行总耗时</caption><title size="lg" tabularNums>{serialT} ms</title></card>
      <card><caption>工作池总耗时</caption><title size="lg" tabularNums>{paraT} ms</title></card>
      <card><caption>加速比</caption><title size="lg" tabularNums>{speedup}×</title></card>
    </row>
    <Chart content={{"chartType":"line","xKey":"name","series":[{"dataKey":"ms","label":"总耗时 (ms)"}],"data":poolRows}}/>
    <text color="secondary">加速比上限就是 worker 数；而 worker 超过 CPU 核数后收益递减——**真正的并行度受 GOMAXPROCS 限制，worker 再多也只是排队。**</text>
    <card gap={1} background="sunken">
      <bold>标准骨架</bold>
      <code>jobs := make(chan Job, 100)</code>
      <code>var wg sync.WaitGroup</code>
      <code>for i := 0; i &lt; workers; i++ { wg.Add(1); go func(){ defer wg.Done(); for j := range jobs { process(j) } }() }</code>
      <code>for _, j := range all { jobs &lt;- j }   // 生产者</code>
      <code>close(jobs); wg.Wait()</code>
      <text color="secondary">`close` 是唯一的结束信号；用 `context` 做超时与取消，用 `errgroup` 收集首个错误。</text>
    </card>
  {/if}

  <card background="sunken">
    <row gap={2} align="center">
      <icon name="zap"/>
      <text>**一句话**：{summary}</text>
    </row>
  </card>
</box>

### 三个可以带走的判断准则

- **不要用 goroutine 数量衡量并发能力**，先看 P 的个数和下游瓶颈在哪里。
- **channel 的容量决定的是缓冲，不是吞吐**；稳态吞吐永远等于较慢一端的速率。
- **锁的选型先看读写比**：读占比高于 70% 再考虑 RWMutex，纯计数走 atomic，其余情况 Mutex 的简单性更值钱。