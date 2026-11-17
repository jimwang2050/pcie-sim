/** Product capability subset, not a list of everything permitted by PCIe. */
import { LINK_WIDTHS } from '../core/link.js';
export const WIDTHS = LINK_WIDTHS;
const all = [1, 2, 3, 4, 5, 6];
const nfm = [1, 2, 3, 4, 5];
const entries = {
  link_training: [all, ['nonflit', 'flit'], 'schematic', '训练/Flit 为教学示意，未实现真实 FM 编码'],
  phy_link: [all, ['auto'], 'schematic', 'PHY 为近似模型；模式按速率自动选择'],
  loopback_bert: [all, ['auto'], 'schematic', '环回为预设行为；BERT 判定含 95% 置信上界'],
  flit_gen6: [[6], ['flit'], 'schematic', '256B 布局与故障结果示意，不执行标准 CRC/FEC'],
  enumeration: [nfm, ['nonflit'], 'field-model', '本场景暂仅实现 Non-Flit；FM 事务尚未实现'],
  mem_read: [nfm, ['nonflit'], 'behavior-subset', '本场景暂仅实现 Non-Flit；VC0 信用准入与 Tag 匹配已实现'],
  mem_write: [nfm, ['nonflit'], 'behavior-subset', '本场景暂仅实现 Non-Flit；信用耗尽阻塞与重发已实现'],
  ltssm_pm: [nfm, ['nonflit'], 'schematic', '本场景包含 L0s；FM 电源流程尚未实现'],
  pm_dp: [nfm, ['nonflit'], 'schematic', '本场景暂仅实现 Non-Flit PM 示意'],
  msi_int: [nfm, ['nonflit'], 'schematic', '本场景暂仅实现 Non-Flit；MSI-X Pending 与补发已实现'],
  aer_error: [nfm, ['nonflit'], 'schematic', '本场景暂仅实现 Non-Flit；Mask 抑制消息但仍计数'],
  dpc_rpio: [nfm, ['nonflit'], 'schematic', '本场景暂仅实现 Non-Flit；RP PIO 按请求类型处理'],
  ats: [nfm, ['nonflit'], 'schematic', '本场景暂仅实现 Non-Flit ATS/PRI 示意'],
};
export const SCENARIOS = Object.freeze(Object.fromEntries(Object.entries(entries).map(([key, [gens, modes, fidelity, note]]) => [
  key, Object.freeze({ gens: Object.freeze([...gens]), modes: Object.freeze(modes), fidelity, note }),
])));

export function resolveScenarioConfig(key, input = {}) {
  const capability = SCENARIOS[key];
  if (!capability) throw new RangeError(`未知场景：${key}`);
  const gen = input.gen ?? (key === 'flit_gen6' ? 6 : 3);
  const width = input.width ?? 8;
  const mode = input.mode ?? 'auto';
  if (!capability.gens.includes(gen) || !WIDTHS.includes(width)) throw new RangeError(`本场景暂不支持 Gen${gen} x${width}：${capability.note}`);
  if (!['auto', 'nonflit', 'flit'].includes(mode)) throw new RangeError('未知传输模式');
  if (gen === 6 && mode === 'nonflit') throw new RangeError('64 GT/s 必须使用 Flit；请选择自动或 Flit');
  const effectiveMode = mode === 'auto' ? (gen === 6 ? 'flit' : 'nonflit') : mode;
  if (!capability.modes.includes('auto') && !capability.modes.includes(effectiveMode)) {
    throw new RangeError(`本场景暂不支持 ${effectiveMode}：${capability.note}`);
  }
  if (capability.modes.includes('auto') && mode !== 'auto') throw new RangeError(`本场景模式由速率自动选择：${capability.note}`);
  return { gen, width, mode, effectiveMode, fidelity: capability.fidelity, note: capability.note };
}

/**
 * 把用户选择收敛到该场景支持的最近组合，并返回被调整的字段。
 * 与 resolveScenarioConfig 的区别：这里不拒绝，而是给出可运行的合法配置，
 * 使切换场景后界面不会停在无法播放的状态；调整原因由调用方展示。
 */
export function clampScenarioConfig(key, input = {}) {
  const capability = SCENARIOS[key];
  if (!capability) throw new RangeError(`未知场景：${key}`);
  const requested = {
    gen: input.gen ?? (key === 'flit_gen6' ? 6 : 3),
    width: input.width ?? 8,
    mode: input.mode ?? 'auto',
  };
  const changes = [];
  const lower = capability.gens.filter(g => g <= requested.gen);
  const gen = capability.gens.includes(requested.gen)
    ? requested.gen
    : (lower.length ? lower[lower.length - 1] : capability.gens[0]);
  if (gen !== requested.gen) changes.push({ field: 'gen', from: requested.gen, to: gen });
  const width = WIDTHS.includes(requested.width) ? requested.width : (WIDTHS.includes(8) ? 8 : WIDTHS[0]);
  if (width !== requested.width) changes.push({ field: 'width', from: requested.width, to: width });
  let mode = ['auto', 'nonflit', 'flit'].includes(requested.mode) ? requested.mode : 'auto';
  if (mode !== requested.mode) changes.push({ field: 'mode', from: requested.mode, to: mode });
  const effectiveOf = m => (m === 'auto' ? (gen === 6 ? 'flit' : 'nonflit') : m);
  const allowed = m => !(gen === 6 && m === 'nonflit') && capability.modes.includes(effectiveOf(m));
  if (capability.modes.includes('auto') && mode !== 'auto') {
    changes.push({ field: 'mode', from: mode, to: 'auto' });
    mode = 'auto';
  } else if (!allowed(mode)) {
    const fallback = ['auto', 'nonflit', 'flit'].find(allowed);
    changes.push({ field: 'mode', from: mode, to: fallback });
    mode = fallback;
  }
  return { config: { gen, width, mode }, changes };
}
