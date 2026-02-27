export class ClassifierCache<T> {
    private readonly maxEntries: number;
    private readonly ttlMs: number;
    private readonly store = new Map<string, { value: T; expireAt: number }>();

    constructor(maxEntries = 1000, ttlMs = 5 * 60 * 1000) {
        this.maxEntries = Math.max(1, maxEntries);
        this.ttlMs = Math.max(1000, ttlMs);
    }

    get(key: string): T | null {
        const hit = this.store.get(key);
        if (!hit) return null;
        if (hit.expireAt <= Date.now()) {
            this.store.delete(key);
            return null;
        }

        // LRU: refresh insertion order
        this.store.delete(key);
        this.store.set(key, hit);
        return hit.value;
    }

    set(key: string, value: T): void {
        const expireAt = Date.now() + this.ttlMs;
        if (this.store.has(key)) {
            this.store.delete(key);
        }
        this.store.set(key, { value, expireAt });

        while (this.store.size > this.maxEntries) {
            const oldestKey = this.store.keys().next().value;
            if (!oldestKey) break;
            this.store.delete(oldestKey);
        }
    }
}
