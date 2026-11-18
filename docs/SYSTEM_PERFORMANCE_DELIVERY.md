# PCIe 系统性能模型 P0–P1

已获批范围见[模型方案](SYSTEM_PERFORMANCE_MODEL_PLAN.md)。本交付新增 Node CLI 与可从 JS 直接调用的性能核心，不替换原协议教学页面。

## 运行

```sh
node scripts/perf.mjs matrix --count 256
node scripts/perf.mjs budget --scenario ep-ddr --gen 6 --lanes 16
node scripts/perf.mjs simulate --scenario ep-ddr --read-pct 50 --trace 2 --json
node scripts/perf.mjs simulate --config docs/perf-p2p-duplex.json
```

`matrix` 默认运行 EP DMA ↔ DDR、CPU ↔ EP BAR、Host DMA ↔ EP HBM、同 Switch P2P 四个模板与 100/75/50/25/0 五档读比例。指定 `--scenario p2p-reverse` 可单独扫描反向 P2P。自定义多流、节点及窗口请用 `--config`；矩阵模式使用模板流，配置文件只提供 `model` 和 `options`，其 `flows` 由矩阵生成。模拟结果退出码：0 完成、1 输入错误、2 事件超限或无进展。

## 参数与读数

有效吞吐、链路流量、PCIe RTT 和 Tag 持有的计量口径见 [Throughput 与 RTT 模型](THROUGHPUT_RTT_MODEL.md)。

| 层次 | 可调输入 |
| --- | --- |
| 拓扑及链路 | `scenario`、`p2p`、`gen`、`lanes`、`propagationNs`、`framingBytes`、`nfmAvailability` |
| DMA / AXI | `dmaOps`、`dmaBytes`、`axiRead`、`axiWrite`、`axiBurstBytes`；节点 `*.AXI` 可通过 `widthBits × clockGHz / 8` 输入总线容量 |
| RC Bridge | `rcAxiWidthBits`、`rcAxiClockGHz`、`rcBridgeBandwidthGBps`；物理 AXI 峰值 = `widthBits / 8 × clockGHz`，有效上限是桥接器策略且必须 ≤ 物理峰值 |
| PCIe 资源 | `mps`、`mrrs`、`rcb`、`tags`、`completionBytes`、`writeBuffers`、`creditHeaders`、`creditData`、`creditReturnNs` |
| CPU / DMA / CMN / PHY / CTL / Switch / DDR/HBM/BAR | `cmnBandwidthGBps` 默认 **64 GB/s**；`nodes` 可按实际节点名进一步覆盖 `latencyNs`、`iiNs`、`bandwidth`、`writeGBps`、`turnaroundNs`；`targetQueue` 控制目标队列 |
| 负载 | 每流 `readPct`（字节比）、`readBytes`、`writeBytes`、`count`、`startNs`、`intervalNs`、`batch`、`address`、`readOffset`、`writeOffset`；`order: visible-serial` 可比较等待前一操作可见后再发下一笔的成本 |
| 测量 | `options.startNs/endNs` 为左闭右开窗口；`traceOps` 取每流前 N 笔，`traceLimit` 防止输出过大，`maxEvents` 限制运行规模 |

`budget.upperGBps` 是按指定整批业务字节配比的乐观上界，`bounds` 列出独立资源约束；不适合拿来限制某个瞬时窗口内的任意完成配比。Gen6 只计算可用 TLP 区上限。`batchGBps` 从首次提交到整批完成回收；`readGBps/writeGBps` 按采样窗口内可消费/目标可见的字节统计。吞吐主要在大批或稳态窗口比较，单笔测试看延迟。默认零间隔提交整个负载，因此 P99 包含注入队列等待；如需定负载对比，显式设置各流 `intervalNs`。

### RC Bridge 两层能力

物理 AXI 接口与桥接器策略分开，预设有效上限尽量与链路带宽对齐，避免把 1024 bit × 1 GHz 误解成 64 GB/s：

| 概念 | 计算 | Gen6 ×16 示例 |
| --- | --- | --- |
| AXI 物理峰值 | `widthBits / 8 × clockGHz` | 1024 / 8 × 1 = **128 GB/s** |
| Bridge 有效上限 | 预设 = `min(物理峰值, 链路原始带宽)`，可配置 | **128 GB/s** |

| Gen / Lane | AXI 宽度 | 时钟 | 物理峰值 | 链路原始 | 预设有效上限 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Gen4 ×8 | 256 bit | 1 GHz | 32 GB/s | 16 GB/s | 16 GB/s |
| Gen5 ×8 | 256 bit | 1 GHz | 32 GB/s | 32 GB/s | 32 GB/s |
| Gen5 ×16 | 512 bit | 1 GHz | 64 GB/s | 64 GB/s | 64 GB/s |
| Gen6 ×8 | 512 bit | 1 GHz | 64 GB/s | 64 GB/s | 64 GB/s |
| Gen6 ×16 | 1024 bit | 1 GHz | 128 GB/s | 128 GB/s | 128 GB/s |

预设按 Gen/Lane 自动套用（Gen4/5 每 Lane 32 bit，Gen6 每 Lane 64 bit，时钟 1 GHz），三个输入仍可手动覆盖。有效上限超过物理峰值会被拒绝（CLI 报错、页面显示「无法计算」），不会静默截断。解析结果里的 `rcBridge` 同时给出 `interfacePeakGBps` 与 `effectiveGBps`；页面的参数区与「理想吞吐」说明都会分开显示这两个数。

资源表中 `bytes` 是已开始服务的字节，`measuredBytes` 是窗口内串行化的模型线字节（编码和有序集预算已折算到容量）。`waitNs` 在资源实际阻塞时累计，不同事务或资源可以重叠，不能直接相加得到端到端延迟。样本 Trace 给出提交、资源准入和到达、Tag 分配、Cpl 片段、写本地接受、写目标可见的时间；按 `flowId/opId/burstId/txnId` 关联。

### 拓扑阅读与逐跳归因

- 拓扑节点底部细条显示同一次仿真的资源占用率；同节点的 `:tx/:rx/:request/:response` 服务池取平均，避免方向池互相覆盖。
- PCIe Link 的两条方向线继续延伸到 PHY → CTL → Bridge → CMN（以及交换端口 → Fabric）的内部总线：每条总线画成两条带反向箭头的通路，芯片本身保持单块显示。
- 播放器支持 1× / 2× / 4× / 8× / 16× / 32× 倍速；按事件时间比例推进，事件密集处保留最小停留，倍速只改变播放节奏，不改变样本与统计口径。
- 金色边框和「瓶颈」小标签标出解析模型的最紧约束 `bounds[0]`（节点或链路），与实测占用分属两套口径。
- 「端到端延迟构成」把所选 MRd 的首片 RTT 拆成逐跳 `Q / L0 / 串行化 / 切换`，色块宽度为占首片 RTT 的比例，斜纹为等待；点击色块或明细行会高亮对应硬件并刷新节点明细。发起段与接收段列在 RTT 窗口外，用于理解整笔业务流。口径和对账方式见 [Throughput 与 RTT 模型](THROUGHPUT_RTT_MODEL.md#逐跳归因端到端延迟构成)。

## 保真度边界

- 默认节点延迟和 DMA/桥接参数是**示例**，未做硬件校准。AXI 采用读/写窗口、burst、独立传输服务与响应的资源近似；未实现逐 beat 握手、逐 ID 排序或真实 fence。CPU BAR 为单有效发起窗口。Host DMA 计入读源/写回 DDR 的本地服务，按业务操作跨多个 DMA 槽流水。
- Gen4/5 NFM 仅建模 DWORD 对齐 MRd、MWr、CplD 的性能；默认使用 64 位请求头预算。Tag 由 Requester 独立分配，末片返回后回收。P/NP/Cpl 逐跳、逐向各有 Header/Data 池；下游管线接收后按配置延迟回补。单 VC、正常 L0，不模拟完整协议排序、错误、重放及 Tx/Rx 门级时序。
- 地址为工作负载偏移，RAM/BAR 路由由拓扑声明；P2P 禁用或 ACS 重定向报不可用，未经验证的 Root 转发不会被默认为可用。SMMU、缓存/一致性、Root P2P 转发和真实 Gen6 装箱属于后续范围。

## 本地验收

- `npm test`：129/129 通过，其中 13 项性能回归，含 25 组路径/配比组合、空载读写手算、末片释放 Tag、Credit 守恒、双端同向争用、截断窗口、RC Bridge 两层预设与逐跳 RTT 对账。
- `npm run check:site`：65 个文件、2 个入口（`index.html`、`performance.html`），0 警告、0 错误；性能核心由 CLI 与 Node 测试加载。
- 浏览器：13 场景冒烟 18 条 + 性能页 10 条（Chromium / Firefox / WebKit 三套），其中性能页覆盖 RC Bridge 预设、逐跳延迟构成与拓扑高亮、节点占用条/瓶颈标记、手动覆盖与超限拒绝。
- `matrix --count 256`：20 组全部完成。下表是 Gen4 ×8 示例的整批有效带宽，单位 GB/s；DMA/P2P 为 512 B/操作，CPU BAR 为 4 B/操作。

| 发起路径 | 纯读 | 50:50 | 纯写 |
| --- | ---: | ---: | ---: |
| EP DMA → 主机 DDR | 13.83 | 17.42 | 13.82 |
| CPU → EP BAR | 0.012 | 0.020 | 0.066 |
| Host DMA ↔ EP HBM | 13.58 | 17.91 | 13.48 |
| EP A → Switch → EP B | 13.72 | 24.49 | 13.76 |

同 Switch 50:50 的 24.49 GB/s 是两个方向交付的业务字节合计；每向仍独立受自身容量约束。双端样例则验证了 A 写 B 与 B 读 A 的返回数据会竞争同一方向。
