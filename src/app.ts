import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { type Clock, systemClock } from "./clock.ts";
import { type MetricsProvider, PLATFORMS } from "./providers/provider.ts";
import { DEFAULT_RETRY, type RetryPolicy } from "./retry.ts";
import { type Connection, SyncAlreadyRunningError, SyncService } from "./sync.ts";

export type AppDeps = {
  providers: Record<string, MetricsProvider>;
  clock?: Clock;
  retry?: RetryPolicy;
};

const isIso = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);

export function createApp(db: DatabaseSync, deps: AppDeps) {
  const clock = deps.clock ?? systemClock;
  const service = new SyncService(db, deps.providers, clock, deps.retry ?? DEFAULT_RETRY);
  const app = new Hono();

  const connection = (id: string) =>
    db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as Connection | undefined;
  const publicConnection = ({ access_token: _token, ...rest }: Connection) => rest;

  app.get("/health", (c) => c.json({ ok: true }));

  // Recebe uma conexão já autorizada. O token é guardado como veio (fictício aqui).
  app.post("/connections", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const platform = typeof body?.platform === "string" ? body.platform : "";
    const accountId = typeof body?.account_id === "string" ? body.account_id.trim() : "";
    const token = typeof body?.access_token === "string" ? body.access_token : "";
    if (!(PLATFORMS as readonly string[]).includes(platform) || !accountId || !token) {
      return c.json({ error: `platform (${PLATFORMS.join(", ")}), account_id e access_token são obrigatórios` }, 400);
    }
    const existing = db
      .prepare("SELECT * FROM connections WHERE platform = ? AND account_id = ?")
      .get(platform, accountId) as Connection | undefined;
    if (existing) {
      db.prepare("UPDATE connections SET access_token = ? WHERE id = ?").run(token, existing.id);
      return c.json(publicConnection({ ...existing, access_token: token }), 200);
    }
    const created: Connection = { id: `con_${crypto.randomUUID()}`, platform, account_id: accountId, access_token: token };
    db.prepare(
      "INSERT INTO connections (id, platform, account_id, access_token, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(created.id, platform, accountId, token, clock.now().toISOString());
    return c.json(publicConnection(created), 201);
  });

  app.post("/connections/:id/syncs", async (c) => {
    const found = connection(c.req.param("id"));
    if (!found) return c.json({ error: "conexão não encontrada" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!isIso(body?.since) || !isIso(body?.until) || body.since >= body.until) {
      return c.json({ error: "since e until (ISO 8601, since < until) são obrigatórios" }, 400);
    }
    try {
      const run = await service.sync(found, { since: body.since, until: body.until });
      return c.json(run, run.status === "succeeded" ? 200 : 502);
    } catch (error) {
      if (error instanceof SyncAlreadyRunningError) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  app.get("/connections/:id/syncs", (c) => {
    if (!connection(c.req.param("id"))) return c.json({ error: "conexão não encontrada" }, 404);
    const ids = db
      .prepare("SELECT id FROM sync_runs WHERE connection_id = ? ORDER BY started_at DESC, rowid DESC")
      .all(c.req.param("id")) as Array<{ id: string }>;
    return c.json({ syncs: ids.map(({ id }) => service.run(id)) });
  });

  app.get("/connections/:id/metrics", (c) => {
    const found = connection(c.req.param("id"));
    if (!found) return c.json({ error: "conexão não encontrada" }, 404);
    const posts = db
      .prepare(
        "SELECT post_id, published_at, views, likes, comments, observed_at, first_seen_at, fetched_at FROM posts WHERE connection_id = ? ORDER BY published_at, post_id",
      )
      .all(found.id) as Array<{ views: number; likes: number; comments: number; fetched_at: string }>;
    const totals = posts.reduce(
      (sum, post) => ({ views: sum.views + post.views, likes: sum.likes + post.likes, comments: sum.comments + post.comments }),
      { views: 0, likes: 0, comments: 0 },
    );
    const lastFetched = posts.reduce<string | null>((max, post) => (max && max > post.fetched_at ? max : post.fetched_at), null);
    return c.json({ connection: publicConnection(found), totals, posts_count: posts.length, last_fetched_at: lastFetched, posts });
  });

  app.get("/connections/:id/posts/:postId/snapshots", (c) => {
    const rows = db
      .prepare(
        "SELECT views, likes, comments, observed_at, fetched_at, sync_id FROM metric_snapshots WHERE connection_id = ? AND post_id = ? ORDER BY fetched_at, rowid",
      )
      .all(c.req.param("id"), c.req.param("postId"));
    return c.json({ snapshots: rows });
  });

  return app;
}
