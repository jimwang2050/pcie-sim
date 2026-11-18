export class Resources {
  constructor(clock) {
    this.clock = clock;
    this.pools = new Map();
    this.waiters = new Set();
    this.dispatching = false;
  }

  pool(id, capacity = 1) {
    if (!this.pools.has(id)) this.pools.set(id, {
      id, capacity, used: 0, peak: 0, claims: 0, released: 0, blocked: 0,
      waitNs: 0, occupiedNs: 0, last: 0, users: new Set(), transfers: 0, bytes: 0,
    });
    const pool = this.pools.get(id);
    if (pool.capacity !== capacity) throw new Error(`Resource capacity changed: ${id}`);
    return pool;
  }

  acquire(needs, callback, observe = () => {}) {
    const request = { needs: needs.filter(need => need.amount > 0).map(need => ({
      pool: this.pool(need.id, need.capacity), amount: need.amount, end: null,
    })), at: this.clock.time, checkedAt: this.clock.time, callback, observe,
    blocked: new Set(), previousBlockers: [] };
    for (const { pool, amount } of request.needs) {
      if (amount > pool.capacity) throw new RangeError(`Demand exceeds ${pool.id}`);
      pool.users.add(request);
      observe('enqueue', pool.id, { amount, used: pool.used, capacity: pool.capacity });
    }
    this.waiters.add(request);
    this.dispatch();
  }

  dispatch() {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      for (const request of this.waiters) {
        for (const pool of request.previousBlockers) pool.waitNs += this.clock.time - request.checkedAt;
        const blockers = request.needs.filter(({ pool, amount }) => pool.used + amount > pool.capacity);
        request.previousBlockers = blockers.map(({ pool }) => pool);
        request.checkedAt = this.clock.time;
        for (const { pool, amount } of blockers) {
          if (request.blocked.has(pool.id)) continue;
          request.blocked.add(pool.id);
          pool.blocked++;
          request.observe('block', pool.id, { amount, used: pool.used, capacity: pool.capacity });
        }
        if (blockers.length) continue;
        this.waiters.delete(request);
        const now = this.clock.time;
        for (const { pool, amount } of request.needs) {
          pool.users.delete(request);
          this.update(pool);
          pool.used += amount;
          pool.peak = Math.max(pool.peak, pool.used);
          pool.claims += amount;
          request.observe('grant', pool.id, { waitNs: now - request.at, amount, used: pool.used, capacity: pool.capacity });
        }
        request.callback(id => {
          const item = request.needs.find(need => need.pool.id === id);
          if (!item || item.end !== null) throw new Error(`Unexpected release: ${id}`);
          const { pool, amount } = item;
          item.end = this.clock.time;
          this.update(pool);
          pool.used -= amount;
          pool.released += amount;
          request.observe('release', id, { heldNs: item.end - now, amount, used: pool.used, capacity: pool.capacity });
          this.dispatch();
        });
      }
    } finally {
      this.dispatching = false;
    }
  }

  update(pool) {
    pool.occupiedNs += (this.clock.time - pool.last) * pool.used;
    pool.last = this.clock.time;
  }

  report(duration) {
    for (const request of this.waiters) {
      for (const pool of request.previousBlockers) pool.waitNs += this.clock.time - request.checkedAt;
      request.checkedAt = this.clock.time;
    }
    return [...this.pools.values()].map(pool => {
      this.update(pool);
      const { last, users, lastKind, ...data } = pool;
      return { ...data, waiting: users.size, utilization: duration ? data.occupiedNs / (duration * data.capacity) : 0 };
    });
  }
}

export const claim = (id, capacity = 1, amount = 1) => ({ id, capacity, amount });
