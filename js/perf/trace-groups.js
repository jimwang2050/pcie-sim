export function groupTrace(events, path) {
  const stages = [
    ['issue', '提交与发起', '业务提交、CPU/DMA 窗口、本地源读取'],
    ['request', 'AXI 与请求去程', 'AXI 准入、Tag 或写缓冲、MRd / MWr 转发'],
    ['target', '目标服务与写入可见', '目标排队、DDR / HBM / BAR 服务、目标可见'],
    ['return', 'Completion 回程与重组', 'CplD 分片、回程转发、请求方接收'],
    ['finish', '本地响应与业务完成', 'AXI 响应、本地接受或写回、操作完成'],
    ['release', '资源释放与 Credit 回补', '并行发生的额度回收，按各自时间戳查看'],
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
