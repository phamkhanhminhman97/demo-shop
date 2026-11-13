import { DurableObject } from "cloudflare:workers";

// Limits concurrent checkouts (CHECKOUT_CONCURRENCY) to protect the partner payment API.
export class CheckoutGate extends DurableObject<Env> {
  private active = 0;
  private waiting: Array<() => void> = [];

  async acquire(limit: number): Promise<void> {
    if (this.active < limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }
}
