import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.ts";
import { type MetricsProvider, PermanentProviderError, type ProviderPost } from "./providers/provider.ts";
import { type Attempt, RetriesExhaustedError, RetryAfterTooLongError, type RetryPolicy, withRetry } from "./retry.ts";

export type Connection = { id: string; platform: string; account_id: string; access_token: string };

export type SyncRun = {
  id: string;
  connection_id: string;
  window_since: string;
  window_until: string;
  status: "running" | "succeeded" | "failed" | "rate_limited";
  started_at: string;
  finished_at: string | null;
  provider_calls: number;
  posts_received: number;
  posts_new: number;
  posts_updated: number;
  posts_unchanged: number;
  attempts: Attempt[];
  error: string | null;
  retry_at: string | null;
};

type PostRow = { views: number; likes: number; comments: number; observed_at: string | null };

export class SyncAlreadyRunningError extends Error {}

/**
 * Chave do snapshot. Se a rede informa quando mediu, a medição é a identidade;
 * senão, os próprios números são. Assim a mesma leitura repetida nunca vira linha nova.
 */
function snapshotKey(post: ProviderPost): string {
  if (post.observed_at) return `obs:${post.observed_at}`;
  return `val:${post.views}:${post.likes}:${post.comments}`;
}

export class SyncService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly providers: Record<string, MetricsProvider>,
    private readonly clock: Clock,
    private readonly policy: RetryPolicy,
  ) {}

  async sync(connection: Connection, window: { since: string; until: string }): Promise<SyncRun> {
    const provider = this.providers[connection.platform];
    if (!provider) throw new Error(`sem provedor para ${connection.platform}`);
    const runId = this.start(connection.id, window);
    const attempts: Attempt[] = [];

    try {
      let cursor: string | null = null;
      do {
        const page = await withRetry(
          () => {
            this.bump(runId, "provider_calls");
            return provider.listPosts({
              accessToken: connection.access_token,
              accountId: connection.account_id,
              since: window.since,
              until: window.until,
              cursor,
            });
          },
          this.policy,
          this.clock,
          (attempt) => attempts.push(attempt),
        );
        this.store(connection.id, runId, page.posts);
        cursor = page.next_cursor;
      } while (cursor);
      this.finish(runId, "succeeded", attempts);
    } catch (error) {
      if (error instanceof RetryAfterTooLongError) {
        const retryAt = new Date(this.clock.now().getTime() + error.retryAfterMs).toISOString();
        this.finish(runId, "rate_limited", attempts, error.message, retryAt);
      } else if (error instanceof RetriesExhaustedError || error instanceof PermanentProviderError) {
        this.finish(runId, "failed", attempts, error.message);
      } else {
        this.finish(runId, "failed", attempts, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
    return this.run(runId)!;
  }

  run(id: string): SyncRun | undefined {
    const row = this.db.prepare("SELECT * FROM sync_runs WHERE id = ?").get(id) as
      | (Omit<SyncRun, "attempts"> & { attempts_json: string })
      | undefined;
    if (!row) return undefined;
    const { attempts_json, ...rest } = row;
    return { ...rest, attempts: JSON.parse(attempts_json) as Attempt[] };
  }

  /** Grava a página inteira numa transação: ou entra tudo, ou nada. */
  private store(connectionId: string, runId: string, posts: ProviderPost[]): void {
    const fetchedAt = this.clock.now().toISOString();
    const counts = { received: posts.length, new: 0, updated: 0, unchanged: 0 };
    const select = this.db.prepare(
      "SELECT views, likes, comments, observed_at FROM posts WHERE connection_id = ? AND post_id = ?",
    );
    const upsert = this.db.prepare(`
      INSERT INTO posts (connection_id, post_id, published_at, views, likes, comments, observed_at, first_seen_at, fetched_at, last_sync_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (connection_id, post_id) DO UPDATE SET
        published_at = excluded.published_at,
        views = excluded.views,
        likes = excluded.likes,
        comments = excluded.comments,
        observed_at = excluded.observed_at,
        fetched_at = excluded.fetched_at,
        last_sync_id = excluded.last_sync_id`);
    const touch = this.db.prepare(
      "UPDATE posts SET fetched_at = ?, last_sync_id = ? WHERE connection_id = ? AND post_id = ?",
    );
    const snapshot = this.db.prepare(`
      INSERT OR IGNORE INTO metric_snapshots (connection_id, post_id, snapshot_key, views, likes, comments, observed_at, fetched_at, sync_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    this.transaction(() => {
      for (const post of posts) {
        const current = select.get(connectionId, post.post_id) as PostRow | undefined;
        // Uma medição mais antiga que a guardada (resposta atrasada) não sobrescreve a mais nova.
        const older = Boolean(current?.observed_at && post.observed_at && post.observed_at < current.observed_at);
        const same =
          current !== undefined &&
          current.views === post.views &&
          current.likes === post.likes &&
          current.comments === post.comments;

        if (!current) counts.new += 1;
        else if (same || older) counts.unchanged += 1;
        else counts.updated += 1;

        if (older) {
          touch.run(fetchedAt, runId, connectionId, post.post_id);
        } else {
          upsert.run(
            connectionId,
            post.post_id,
            post.published_at,
            post.views,
            post.likes,
            post.comments,
            post.observed_at ?? null,
            fetchedAt,
            fetchedAt,
            runId,
          );
        }
        snapshot.run(
          connectionId,
          post.post_id,
          snapshotKey(post),
          post.views,
          post.likes,
          post.comments,
          post.observed_at ?? null,
          fetchedAt,
          runId,
        );
      }
      this.db
        .prepare(
          "UPDATE sync_runs SET posts_received = posts_received + ?, posts_new = posts_new + ?, posts_updated = posts_updated + ?, posts_unchanged = posts_unchanged + ? WHERE id = ?",
        )
        .run(counts.received, counts.new, counts.updated, counts.unchanged, runId);
    });
  }

  private start(connectionId: string, window: { since: string; until: string }): string {
    const id = `sync_${crypto.randomUUID()}`;
    try {
      this.db
        .prepare(
          "INSERT INTO sync_runs (id, connection_id, window_since, window_until, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)",
        )
        .run(id, connectionId, window.since, window.until, this.clock.now().toISOString());
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) {
        throw new SyncAlreadyRunningError("já existe um sync rodando para esta conexão");
      }
      throw error;
    }
    return id;
  }

  private bump(runId: string, column: "provider_calls"): void {
    this.db.prepare(`UPDATE sync_runs SET ${column} = ${column} + 1 WHERE id = ?`).run(runId);
  }

  private finish(runId: string, status: SyncRun["status"], attempts: Attempt[], error?: string, retryAt?: string): void {
    this.db
      .prepare("UPDATE sync_runs SET status = ?, finished_at = ?, attempts_json = ?, error = ?, retry_at = ? WHERE id = ?")
      .run(status, this.clock.now().toISOString(), JSON.stringify(attempts), error ?? null, retryAt ?? null, runId);
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
