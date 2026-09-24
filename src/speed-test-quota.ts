interface Bucket {
  windowStartedAt: number;
  completed: number;
  active: number;
}

export interface SpeedTestLease {
  release(): void;
}

/** Bounds diagnostic bandwidth without persisting network-test state or secrets. */
export class SpeedTestQuota {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly maxPerWindow = 4, private readonly windowMs = 60_000) {
    if (!Number.isSafeInteger(maxPerWindow) || maxPerWindow < 1 || maxPerWindow > 32 || !Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 3_600_000) throw new Error("Invalid speed-test quota");
  }

  tryAcquire(subject: string, now = Date.now()): SpeedTestLease | undefined {
    if (subject.trim().length === 0) return undefined;
    const current = this.buckets.get(subject);
    const bucket = current === undefined || now - current.windowStartedAt >= this.windowMs
      ? { windowStartedAt: now, completed: 0, active: 0 }
      : current;
    if (bucket.active > 0 || bucket.completed >= this.maxPerWindow) return undefined;
    bucket.active += 1;
    this.buckets.set(subject, bucket);
    let released = false;
    return { release: () => { if (released) return; released = true; const latest = this.buckets.get(subject); if (latest === undefined) return; latest.active = Math.max(0, latest.active - 1); latest.completed += 1; this.buckets.set(subject, latest); } };
  }
}
