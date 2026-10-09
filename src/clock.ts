export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Relógio de teste: sleep não espera, só avança o tempo e registra quanto. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];

  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current = new Date(this.current.getTime() + ms);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
