/**
 * 轨迹导出：版本化事件 schema + BigInt 无损序列化。
 *
 * 事件保留 eventId / modelTimeNs / fidelity / requestId / causeId，
 * 64 位地址等 BigInt 一律转成 0x 十六进制字符串，避免 JSON 精度损失。
 */
export const TRACE_SCHEMA_VERSION = 1;

function bigintReplacer(_key, value) {
  return typeof value === 'bigint' ? `0x${value.toString(16).toUpperCase()}` : value;
}

/** 深拷贝并去掉 BigInt（用于 JSON 导出）。 */
export function bigintSafe(value) {
  return JSON.parse(JSON.stringify(value, bigintReplacer));
}

export function serializeEvent(ev) {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    eventId: ev.id,
    modelTimeNs: ev.t_ns,
    durationNs: ev.dur_ns,
    layer: ev.layer,
    row: ev.row,
    side: ev.side,
    direction: ev.dir,
    type: ev.type,
    status: ev.status,
    phase: ev.phase ?? null,
    summary: ev.summary,
    detail: ev.detail || '',
    fidelity: ev.fidelity || (ev.packet && ev.packet.fidelity) || 'model',
    requestId: ev.requestId ?? null,
    causeId: ev.causeId ?? null,
    packet: ev.packet ? bigintSafe(ev.packet) : null,
  };
}

export function buildTraceDocument({ scenario, config, effective, durationNs, clockNs, events, generatedAt }) {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    app: 'pcie-sim',
    generatedAt: generatedAt || new Date().toISOString(),
    scenario,
    config: {
      gen: config.gen,
      width: config.width,
      mode: config.mode,
    },
    effective: effective ? {
      gen: effective.gen,
      width: effective.width,
      mode: effective.effectiveMode,
      fidelity: effective.fidelity,
      note: effective.note,
    } : null,
    durationNs,
    clockNs,
    timeBase: {
      unit: 'ns',
      note: '模型时间；界面按 1:100 压缩显示，播放速度不影响事件时间',
    },
    eventCount: events.length,
    events: events.map(serializeEvent),
  };
}

export function stringifyTrace(doc) {
  return JSON.stringify(doc, bigintReplacer, 2);
}
