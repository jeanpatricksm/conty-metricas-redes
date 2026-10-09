import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { FakeProvider } from "./providers/fake-provider.ts";
import { PLATFORMS } from "./providers/provider.ts";

// Em dev, todas as redes usam o provedor simulado com alguns posts de exemplo.
const fake = new FakeProvider(2).upsert(
  { post_id: "p1", published_at: "2026-05-01T12:00:00.000Z", views: 1200, likes: 80, comments: 5 },
  { post_id: "p2", published_at: "2026-05-02T12:00:00.000Z", views: 5400, likes: 310, comments: 22 },
  { post_id: "p3", published_at: "2026-05-03T12:00:00.000Z", views: 900, likes: 40, comments: 1 },
);
const providers = Object.fromEntries(PLATFORMS.map((platform) => [platform, fake]));

const db = openDatabase(process.env.DB_PATH ?? "data/metricas.sqlite");
const port = Number(process.env.PORT ?? 3004);
serve({ fetch: createApp(db, { providers }).fetch, port }, (info) => {
  console.log(`métricas em http://127.0.0.1:${info.port}`);
});
