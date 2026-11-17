/**
 * ATS（Address Translation Services）+ PRI（Page Request Interface）模型。
 *
 * 教学简化：只维护设备侧 ATC（Address Translation Cache）条目与关键计数，
 * 不实现完整页表，也不区分 PASID。
 */
export class AtsModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.priEnabled = false;
    this.stu = 4096;
    this.prgIndex = 0;
    this.cache = [];
    this.hits = 0;
    this.misses = 0;
    this.requests = 0;
    this.completions = 0;
    this.invalidRequests = 0;
    this.invalidations = 0;
    this.pageRequests = 0;
    this.prgResponses = 0;
  }

  enable({ stu = 4096 } = {}) {
    this.enabled = true;
    this.stu = stu;
  }

  enablePri(prgIndex = 0) {
    this.priEnabled = true;
    this.prgIndex = prgIndex;
  }

  /** 查询 ATC：命中返回 true，未命中返回 false 并计数。 */
  lookup(va) {
    if (this.cache.some((e) => e.va === va)) {
      this.hits += 1;
      return true;
    }
    this.misses += 1;
    return false;
  }

  fill(va, pa, size = this.stu) {
    const hit = this.cache.find((e) => e.va === va);
    if (hit) {
      hit.pa = pa;
      hit.size = size;
      return hit;
    }
    const entry = { va, pa, size };
    this.cache.push(entry);
    return entry;
  }

  /** 失效：va 为空表示整表失效。 */
  invalidate(va = null) {
    this.cache = va === null ? [] : this.cache.filter((e) => e.va !== va);
    this.invalidations += 1;
  }

  request() {
    this.requests += 1;
  }

  complete() {
    this.completions += 1;
  }

  invalidRequest() {
    this.invalidRequests += 1;
  }

  pageRequest() {
    this.pageRequests += 1;
  }

  prgResponse() {
    this.prgResponses += 1;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      priEnabled: this.priEnabled,
      stu: this.stu,
      prgIndex: this.prgIndex,
      cache: this.cache.map((e) => ({ ...e })),
      hits: this.hits,
      misses: this.misses,
      requests: this.requests,
      completions: this.completions,
      invalidRequests: this.invalidRequests,
      invalidations: this.invalidations,
      pageRequests: this.pageRequests,
      prgResponses: this.prgResponses,
    };
  }
}
