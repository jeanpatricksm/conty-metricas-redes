import type { Clock } from "./clock.ts";
import { PermanentProviderError, RateLimitedError, TransientProviderError } from "./providers/provider.ts";

export type RetryPolicy = {
  /** Tentativas totais por chamada ao provedor, contando a primeira. */
  maxAttempts: number;
  /** Backoff de falha transitória: base * 2^(tentativa-1). */
  baseDelayMs: number;
  /** Teto de qualquer espera. Retry-After maior que isso encerra o sync. */
  maxWaitMs: number;
};

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 500, maxWaitMs: 60_000 };

export type Attempt = { attempt: number; error: string; waited_ms: number | null };

/** Retry-After acima do teto: não esperamos, o sync termina e informa quando tentar. */
export class RetryAfterTooLongError extends Error {
  constructor(readonly retryAfterMs: number, readonly maxWaitMs: number) {
    super(`provedor pediu ${retryAfterMs}ms de espera, acima do teto de ${maxWaitMs}ms`);
  }
}

export class RetriesExhaustedError extends Error {
  constructor(readonly attempts: Attempt[]) {
    super(`falhou depois de ${attempts.length} tentativas: ${attempts.at(-1)?.error ?? ""}`);
  }
}

export async function withRetry<T>(
  call: () => Promise<T>,
  policy: RetryPolicy,
  clock: Clock,
  onAttempt: (attempt: Attempt) => void = () => {},
): Promise<T> {
  const attempts: Attempt[] = [];
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (error instanceof PermanentProviderError) throw error;
      if (!(error instanceof RateLimitedError) && !(error instanceof TransientProviderError)) throw error;

      const last = attempt >= policy.maxAttempts;
      let wait: number | null = null;
      if (!last) {
        if (error instanceof RateLimitedError) {
          if (error.retryAfterMs > policy.maxWaitMs) {
            onAttempt({ attempt, error: error.message, waited_ms: null });
            throw new RetryAfterTooLongError(error.retryAfterMs, policy.maxWaitMs);
          }
          wait = error.retryAfterMs;
        } else {
          wait = Math.min(policy.maxWaitMs, policy.baseDelayMs * 2 ** (attempt - 1));
        }
      }
      const record = { attempt, error: error.message, waited_ms: wait };
      attempts.push(record);
      onAttempt(record);
      if (last || wait === null) throw new RetriesExhaustedError(attempts);
      await clock.sleep(wait);
    }
  }
}
