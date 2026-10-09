import {
  type ListPostsInput,
  type MetricsProvider,
  type ProviderPage,
  type ProviderPost,
  PermanentProviderError,
  RateLimitedError,
  TransientProviderError,
} from "./provider.ts";

/** Falha programada para a próxima chamada. */
export type Fault =
  | { kind: "timeout" }
  | { kind: "server_error" }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "unauthorized" };

/**
 * Provedor simulado. Guarda posts em memória, pagina por cursor e, quando
 * pedido, devolve falhas na ordem programada ou repete um post na resposta
 * (como redes reais fazem entre páginas).
 */
export class FakeProvider implements MetricsProvider {
  private readonly posts = new Map<string, ProviderPost>();
  private readonly faults: Fault[] = [];
  calls = 0;
  duplicateInResponse = false;

  constructor(private readonly pageSize = 2) {}

  upsert(...posts: ProviderPost[]): this {
    for (const post of posts) this.posts.set(post.post_id, post);
    return this;
  }

  failNext(...faults: Fault[]): this {
    this.faults.push(...faults);
    return this;
  }

  async listPosts(input: ListPostsInput): Promise<ProviderPage> {
    this.calls += 1;
    const fault = this.faults.shift();
    if (fault?.kind === "timeout") throw new TransientProviderError("timeout");
    if (fault?.kind === "server_error") throw new TransientProviderError("502 bad gateway");
    if (fault?.kind === "rate_limited") throw new RateLimitedError(fault.retryAfterMs);
    if (fault?.kind === "unauthorized" || input.accessToken === "revoked") {
      throw new PermanentProviderError("401 token inválido");
    }

    const inWindow = [...this.posts.values()]
      .filter((post) => post.published_at >= input.since && post.published_at < input.until)
      .sort((a, b) => a.published_at.localeCompare(b.published_at) || a.post_id.localeCompare(b.post_id));
    const start = input.cursor ? Number(input.cursor) : 0;
    const page = inWindow.slice(start, start + this.pageSize).map((post) => ({ ...post }));
    if (this.duplicateInResponse && page[0]) page.push({ ...page[0] });
    const next = start + this.pageSize;
    return { posts: page, next_cursor: next < inWindow.length ? String(next) : null };
  }
}
