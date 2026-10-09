// Fronteira com o provedor. A regra de negócio só conhece este contrato;
// cada rede (Instagram, TikTok, YouTube, X) seria um adaptador que o implementa.

export const PLATFORMS = ["instagram", "tiktok", "youtube", "x"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type ProviderPost = {
  /** Id do post na rede. Junto com a conexão, é a identidade do post. */
  post_id: string;
  published_at: string;
  views: number;
  likes: number;
  comments: number;
  /** Instante em que a rede diz ter medido os números, se ela informar. */
  observed_at?: string;
};

export type ProviderPage = { posts: ProviderPost[]; next_cursor: string | null };

export type ListPostsInput = {
  accessToken: string;
  accountId: string;
  /** Janela por data de publicação: since <= published_at < until. */
  since: string;
  until: string;
  cursor: string | null;
};

export interface MetricsProvider {
  listPosts(input: ListPostsInput): Promise<ProviderPage>;
}

/** 429. retryAfterMs vem do header Retry-After, já convertido. */
export class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`rate limited, retry after ${retryAfterMs}ms`);
  }
}

/** Timeout, 5xx, conexão caída: vale tentar de novo. */
export class TransientProviderError extends Error {}

/** 401, 403, 400: tentar de novo não resolve. */
export class PermanentProviderError extends Error {}

/** Converte o header Retry-After (segundos ou data HTTP) em milissegundos. */
export function parseRetryAfter(header: string | null, now: Date): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now.getTime());
}
