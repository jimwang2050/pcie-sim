/**
 * 虚拟时间调度器：按 (时间, 入队序号) 排序的离散事件队列。
 * 不依赖浏览器，可在 node:test 中直接跑。
 */
export class Scheduler {
  constructor() {
    this.items = [];
    this.seq = 0;
    this.time = 0;
  }

  clear() {
    this.items = [];
    this.seq = 0;
    this.time = 0;
  }

  /** 在绝对时间 t（ns）执行 fn。 */
  at(t, fn, meta = {}) {
    const item = { t, seq: this.seq++, fn, meta };
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = this.items[mid];
      if (m.t < t || (m.t === t && m.seq < item.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.items.splice(lo, 0, item);
    return item;
  }

  /** 在当前位置之后 delayNs 执行。 */
  after(delayNs, fn, meta = {}) {
    return this.at(this.time + Math.max(0, delayNs), fn, meta);
  }

  step() {
    if (!this.items.length) return null;
    const item = this.items.shift();
    this.time = item.t;
    item.fn(item.meta);
    return item;
  }

  get pending() {
    return this.items.length;
  }
}
