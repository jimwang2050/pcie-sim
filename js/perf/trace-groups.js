export function groupTrace(events, path) {
  const stages = [
    ['issue', '提交与发起',
      '业务提交（读 / 写、字节数、操作号）→ CPU / DMA 窗口申请（ops 与 bytes 额度、当前占用）→ 本地源读取（HBM / BAR 起始地址）'],
    ['request', 'AXI 与请求去程',
      'AXI 准入（burst 拆分、排队等待）→ 分配 Tag 或占用写缓冲 → MRd / MWr 逐跳转发（线字节、事务号）'],
    ['target', '目标服务与写入可见',
      '目标侧排队（等待额度、占用）→ DDR / HBM / BAR 服务（服务时长、读写字节）→ MWr 写入目标可见'],
    ['return', 'Completion 回程与重组',
      'CplD 按片回程转发 → 请求方逐片接收（片段序号、字节、该片 RTT）→ Completion 重组完成'],
    ['finish', '本地响应与业务完成',
      'AXI 响应写回（R / B 通道）→ 读本地接受或写本地完成 → 操作号收尾'],
    ['release', '资源释放与 Credit 回补',
      '额度并行回收：释放 ops / bytes（剩余占用、持有时间）与链路 Credit 回补，各自按时间戳排序'],
  ].map(([id, title, description]) => ({ id, title, description, events: [] }));
  const byId = new Map(stages.map(stage => [stage.id, stage]));
  for (const event of events) {
    const node = event.node ?? event.resource.split(':')[0];
    let phase;
    if (event.event === 'release') phase = 'release';
    else if (['done', 'local-accepted'].includes(event.event) || /:(R|B)$/.test(event.resource)) phase = 'finish';
    else if (event.fragment != null || event.packetClass === 'Cpl') phase = 'return';
    else if (node === path.target || event.event === 'target-visible') phase = 'target';
    else if (event.kind === 'read' && !event.burstId && path.localCopy.includes(node)) phase = 'finish';
    else phase = event.burstId ? 'request' : 'issue';
    byId.get(phase).events.push(event);
  }
  return stages.filter(stage => stage.events.length);
}
