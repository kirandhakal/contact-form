interface Bucket {
  resetAt: number;
  count: number;
}

export class FixedWindowRateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number
  ) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { resetAt: now + this.windowMs, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    current.count += 1;
    if (current.count <= this.max) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000) };
  }
}
