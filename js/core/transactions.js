/**
 * Non-Posted 事务跟踪（VC0）。
 *
 * 以 Requester ID + Tag 唯一标识一个未完成请求；Completion 的 Byte Count
 * 表示“包含本包在内仍需完成的字节数”，累计到 0 即事务结束。
 * 只建模同一 VC、8 位 Tag 的教学子集；不实现 PASID、多 VC 与真实重试计时器。
 */
export class Transactions {
  constructor() {
    this.reset();
  }

  reset() {
    this.open = new Map();
    this.seq = 0;
    this.stats = {
      started: 0, completed: 0, duplicates: 0, unexpected: 0, failures: 0, timeouts: 0,
    };
  }

  static key(requester, tag) {
    return `${requester}:${tag}`;
  }

  /** 发起请求；同一 Requester+Tag 已占用时拒绝（Tag 冲突）。 */
  begin({ requester, tag, kind = 'MRd', lengthBytes = 0, at = 0 }) {
    const key = Transactions.key(requester, tag);
    if (this.open.has(key)) {
      this.stats.duplicates += 1;
      return { ok: false, reason: 'tag-busy', key };
    }
    this.seq += 1;
    const tx = {
      id: this.seq, key, requester, tag, kind, remaining: lengthBytes,
      startedAt: at, completions: 0,
    };
    this.open.set(key, tx);
    this.stats.started += 1;
    return { ok: true, tx };
  }

  /**
   * 收到 Completion：Byte Count 为“含本包在内仍需完成”的字节数。
   * 本包携带 dataBytes，扣掉后仍有剩余则保持未完成；归零即事务完成。
   */
  complete({ requester, tag, byteCount = 0, dataBytes = 0, lowerAddress = 0 }) {
    const key = Transactions.key(requester, tag);
    const tx = this.open.get(key);
    if (!tx) {
      this.stats.unexpected += 1;
      return { ok: false, reason: 'no-request', key };
    }
    tx.completions += 1;
    const remaining = byteCount - dataBytes - (lowerAddress & 3);
    tx.remaining = Math.max(0, remaining);
    if (remaining <= 0) {
      this.open.delete(key);
      this.stats.completed += 1;
      return { ok: true, done: true, tx };
    }
    return { ok: true, done: false, tx };
  }

  /** 事务以错误状态结束（Completion Status != SC）。 */
  fail({ requester, tag }) {
    const key = Transactions.key(requester, tag);
    const tx = this.open.get(key);
    if (!tx) {
      this.stats.unexpected += 1;
      return { ok: false, reason: 'no-request', key };
    }
    this.open.delete(key);
    this.stats.failures += 1;
    return { ok: true, tx };
  }

  /** 超时扫描：返回并移除超过 timeoutNs 仍未完成的请求。 */
  expire(now, timeoutNs) {
    if (!(timeoutNs > 0)) return [];
    const expired = [];
    for (const [key, tx] of this.open) {
      if (now - tx.startedAt >= timeoutNs) {
        expired.push({ ...tx });
        this.open.delete(key);
      }
    }
    this.stats.timeouts += expired.length;
    return expired;
  }

  get pending() {
    return this.open.size;
  }

  snapshot() {
    return {
      seq: this.seq,
      open: [...this.open.values()].map((tx) => ({ ...tx })),
      stats: { ...this.stats },
    };
  }

  restore(state) {
    this.seq = state.seq;
    this.open = new Map((state.open || []).map((tx) => [tx.key, { ...tx }]));
    this.stats = { ...state.stats };
  }
}
