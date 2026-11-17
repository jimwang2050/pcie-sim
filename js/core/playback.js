/**
 * 播放速度换算：1× = 每 70ms 推进一步。
 * 加速（2×/4×）通过每 tick 多步实现；慢放（-2×…-32×）通过拉长 tick 实现。
 */
export const BASE_INTERVAL_MS = 70;

export function playbackTiming(speed) {
  const s = Number(speed) || 1;
  if (s >= 1) {
    return { interval: BASE_INTERVAL_MS, batch: Math.max(1, Math.round(s)) };
  }
  return { interval: Math.max(BASE_INTERVAL_MS, Math.round(BASE_INTERVAL_MS / s)), batch: 1 };
}
