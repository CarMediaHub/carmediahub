export interface GatewayStreamLease {
  consume(bytes: number): boolean;
  release(): void;
}

/**
 * Bounds concurrent public media streams per authenticated session. The lease is
 * deliberately process-local: it protects one Core process without introducing
 * another stateful service or exposing quota state to plugin workers.
 */
export class GatewayStreamQuota {
  private readonly active = new Map<string, number>();

  constructor(private readonly maxPerSession = 2, private readonly maxBytesPerStream = 256 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxPerSession) || maxPerSession < 1) throw new Error("Gateway stream quota must be a positive integer");
    if (!Number.isSafeInteger(maxBytesPerStream) || maxBytesPerStream < 1) throw new Error("Gateway stream byte quota must be a positive integer");
  }

  tryAcquire(sessionId: string): GatewayStreamLease | undefined {
    const current = this.active.get(sessionId) ?? 0;
    if (current >= this.maxPerSession) return undefined;
    this.active.set(sessionId, current + 1);
    let released = false;
    let bytes = 0;
    return {
      consume: (chunkBytes: number) => {
        if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 0 || bytes + chunkBytes > this.maxBytesPerStream) return false;
        bytes += chunkBytes;
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        const remaining = (this.active.get(sessionId) ?? 1) - 1;
        if (remaining <= 0) this.active.delete(sessionId);
        else this.active.set(sessionId, remaining);
      }
    };
  }

  activeFor(sessionId: string): number { return this.active.get(sessionId) ?? 0; }
}
