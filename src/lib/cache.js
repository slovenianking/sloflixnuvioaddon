
/** Very small in-memory TTL cache, keyed by string. */
class TTLCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
    return value;
  }

  async getOrLoad(key, loader) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await loader();
    this.set(key, value);
    return value;
  }
}

export { TTLCache };
