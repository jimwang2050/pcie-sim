/**
 * DLLP 与 PM 消息的简化模型（用于 LTSSM 电源管理场景）。
 * 仅建模类型码、名称与语义；CRC16 以 0 占位。
 */

export const DLLP_TYPES = {
  Ack: { code: 0x00, cn: 'Ack', desc: '确认 TLP 已被正确接收（12bit 序列号）' },
  Nak: { code: 0x10, cn: 'Nak', desc: '请求重传（LCRC 错误或序列号不连续）' },
  PM_Enter_L1: { code: 0x20, cn: '进入 L1 请求', desc: '请求链路进入 L1（由下游端口发起的 PM 流程）' },
  PM_Enter_L23: { code: 0x21, cn: '进入 L2/L3 请求', desc: '请求链路进入 L2/L3' },
  PM_Active_State_Request_L1: { code: 0x23, cn: 'ASPM L1 请求', desc: 'ASPM 自主 L1 协商：上游端口请求进入 L1' },
  PM_Request_Ack: { code: 0x24, cn: 'L1 请求确认', desc: '下游端口同意进入 L1' },
  NOP: { code: 0x31, cn: '空 DLLP', desc: '用于链路保活/填充' },
};

export function buildDllp(name) {
  const t = DLLP_TYPES[name];
  if (!t) throw new Error(`未知 DLLP: ${name}`);
  const bytes = [t.code, 0, 0, 0, 0, 0];
  return {
    kind: 'DLLP',
    name,
    code: t.code,
    bytes,
    summary: `${name}（DLLP 0x${t.code.toString(16).toUpperCase().padStart(2, '0')}）`,
    fields: [
      { name: 'DLLP Type', value: `0x${t.code.toString(16).toUpperCase().padStart(2, '0')}`,
        display: name, desc: t.desc },
      { name: '分类', value: 'PM', display: '电源管理 DLLP', desc: '链路级电源管理握手，不经过事务层' },
      { name: 'CRC16', value: '0x0000', display: '占位', desc: '真实链路会附带 16bit DLLP CRC' },
    ],
  };
}

export const PM_MESSAGES = {
  PME_Turn_Off: {
    code: 0x19,
    routing: '011b（向下游广播）',
    cn: 'PME_Turn_Off',
    desc: '电源管理软件要求链路进入 L2/L3 前的关机广播消息',
  },
  PME_TO_Ack: {
    code: 0x1b,
    routing: '101b（向上游发送）',
    cn: 'PME_TO_Ack',
    desc: '上游端口对 PME_Turn_Off 的确认消息',
  },
  PM_PME: {
    code: 0x30,
    routing: '100b（按 ID 路由，向上游报告）',
    cn: 'PM_PME',
    desc: '设备唤醒后上报 PME，通知上游端口 / 系统软件处理唤醒原因',
  },
};

export function buildPmMessage(name) {
  const m = PM_MESSAGES[name];
  if (!m) throw new Error(`未知消息: ${name}`);
  const bytes = [m.code, 0x04, 0x00, 0x00];
  return {
    kind: 'MSG',
    name,
    code: m.code,
    bytes,
    summary: `${name}（Message Code 0x${m.code.toString(16).toUpperCase()}，${m.routing}）`,
    fields: [
      { name: 'Message Code', value: `0x${m.code.toString(16).toUpperCase()}`, display: m.cn, desc: m.desc },
      { name: '路由', value: m.routing, display: m.routing, desc: 'PM 消息的路由方式' },
      { name: '类型', value: 'Msg', display: 'Message（无数据）', desc: 'TLP 消息，不属于 Posted/Non-Posted 内存事务' },
    ],
  };
}
