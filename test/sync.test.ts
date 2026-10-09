import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { FakeClock } from "../src/clock.ts";
import { openDatabase } from "../src/db.ts";
import { FakeProvider } from "../src/providers/fake-provider.ts";
import { parseRetryAfter, TransientProviderError } from "../src/providers/provider.ts";

const T0 = "2026-06-01T12:00:00.000Z";
let clock: FakeClock;
let provider: FakeProvider;
let app: ReturnType<typeof createApp>;
let connectionId: string;

type Run = {
  status: string;
  provider_calls: number;
  posts_received: number;
  posts_new: number;
  posts_updated: number;
  posts_unchanged: number;
  attempts: Array<{ attempt: number; waited_ms: number | null }>;
  retry_at: string | null;
  error: string | null;
};
type Metrics = {
  totals: { views: number; likes: number; comments: number };
  posts_count: number;
  last_fetched_at: string | null;
  posts: Array<{ post_id: string; views: number; fetched_at: string; first_seen_at: string }>;
};

const post = (id: string, day: number, views: number) => ({
  post_id: id,
  published_at: `2026-05-${String(day).padStart(2, "0")}T12:00:00.000Z`,
  views,
  likes: Math.floor(views / 10),
  comments: Math.floor(views / 100),
});

async function json<T>(res: Response | Promise<Response>): Promise<{ status: number; body: T }> {
  const r = await res;
  return { status: r.status, body: (await r.json()) as T };
}

function sync(since: string, until: string) {
  return json<Run>(
    app.request(`/connections/${connectionId}/syncs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ since, until }),
    }),
  );
}

const metrics = () => json<Metrics>(app.request(`/connections/${connectionId}/metrics`));

beforeEach(async () => {
  clock = new FakeClock(new Date(T0));
  provider = new FakeProvider(2).upsert(post("p1", 1, 1000), post("p2", 2, 2000), post("p3", 3, 3000), post("p4", 4, 4000));
  app = createApp(openDatabase(), {
    providers: { instagram: provider },
    clock,
    retry: { maxAttempts: 4, baseDelayMs: 500, maxWaitMs: 30_000 },
  });
  const res = await json<{ id: string }>(
    app.request("/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "instagram", account_id: "ig_ana", access_token: "fake-token" }),
    }),
  );
  connectionId = res.body.id;
});

describe("idempotência", () => {
  it("janelas sobrepostas não contam o mesmo post duas vezes", async () => {
    const first = await sync("2026-05-01T00:00:00.000Z", "2026-05-04T00:00:00.000Z"); // p1..p3
    expect(first.body).toMatchObject({ status: "succeeded", posts_new: 3 });
    const second = await sync("2026-05-02T00:00:00.000Z", "2026-05-05T00:00:00.000Z"); // p2..p4
    expect(second.body).toMatchObject({ status: "succeeded", posts_new: 1, posts_unchanged: 2 });

    const { body } = await metrics();
    expect(body.posts_count).toBe(4);
    expect(body.totals.views).toBe(1000 + 2000 + 3000 + 4000);
  });

  it("post repetido dentro da mesma resposta conta uma vez", async () => {
    provider.duplicateInResponse = true;
    const run = await sync("2026-05-01T00:00:00.000Z", "2026-05-10T00:00:00.000Z");
    expect(run.body.posts_received).toBeGreaterThan(4);
    const { body } = await metrics();
    expect(body.posts_count).toBe(4);
    expect(body.totals.views).toBe(10_000);
  });

  it("número que cresceu substitui o anterior; a mesma leitura não vira snapshot novo", async () => {
    const window = ["2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z"] as const;
    await sync(...window);
    await sync(...window); // mesma leitura
    provider.upsert(post("p1", 1, 1500));
    clock.advance(60_000);
    const updated = await sync(...window);
    expect(updated.body.posts_updated).toBe(1);

    const { body } = await metrics();
    expect(body.totals.views).toBe(1500);
    const snaps = await json<{ snapshots: Array<{ views: number }> }>(
      app.request(`/connections/${connectionId}/posts/p1/snapshots`),
    );
    expect(snaps.body.snapshots.map((s) => s.views)).toEqual([1000, 1500]);
  });

  it("medição mais antiga que chega atrasada não sobrescreve a mais nova", async () => {
    const window = ["2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z"] as const;
    provider.upsert({ ...post("p1", 1, 1500), observed_at: "2026-06-01T11:00:00.000Z" });
    await sync(...window);
    provider.upsert({ ...post("p1", 1, 1000), observed_at: "2026-06-01T10:00:00.000Z" });
    await sync(...window);
    expect((await metrics()).body.totals.views).toBe(1500);
  });
});

describe("falha transitória", () => {
  it("timeout tem retry com backoff e o sync termina", async () => {
    provider.failNext({ kind: "timeout" }, { kind: "server_error" });
    const run = await sync("2026-05-01T00:00:00.000Z", "2026-05-03T00:00:00.000Z");
    expect(run.body.status).toBe("succeeded");
    expect(clock.sleeps).toEqual([500, 1000]);
    expect((await metrics()).body.posts_count).toBe(2);
  });

  it("para no teto de tentativas, sem loop infinito", async () => {
    provider.failNext(...Array.from({ length: 10 }, () => ({ kind: "timeout" as const })));
    const run = await sync("2026-05-01T00:00:00.000Z", "2026-05-03T00:00:00.000Z");
    expect(run.status).toBe(502);
    expect(run.body.status).toBe("failed");
    expect(provider.calls).toBe(4);
    expect(run.body.attempts).toHaveLength(4);
    expect(clock.sleeps).toEqual([500, 1000, 2000]);
  });

  it("token inválido não tem retry", async () => {
    provider.failNext({ kind: "unauthorized" });
    const run = await sync("2026-05-01T00:00:00.000Z", "2026-05-03T00:00:00.000Z");
    expect(run.body.status).toBe("failed");
    expect(provider.calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("falha no meio da paginação mantém o que já foi gravado e o próximo sync completa sem duplicar", async () => {
    // página 1 ok, página 2 falha sempre
    const original = provider.listPosts.bind(provider);
    let calls = 0;
    provider.listPosts = async (input) => {
      calls += 1;
      if (input.cursor) throw new TransientProviderError("timeout");
      return original(input);
    };
    const failed = await sync("2026-05-01T00:00:00.000Z", "2026-05-10T00:00:00.000Z");
    expect(failed.body.status).toBe("failed");
    expect((await metrics()).body.posts_count).toBe(2);

    provider.listPosts = original;
    const ok = await sync("2026-05-01T00:00:00.000Z", "2026-05-10T00:00:00.000Z");
    expect(ok.body).toMatchObject({ status: "succeeded", posts_new: 2, posts_unchanged: 2 });
    expect((await metrics()).body.totals.views).toBe(10_000);
    expect(calls).toBeGreaterThan(1);
  });
});

describe("429 e Retry-After", () => {
  it("espera exatamente o Retry-After do provedor e segue", async () => {
    provider.failNext({ kind: "rate_limited", retryAfterMs: 12_000 });
    const before = clock.now().getTime();
    const run = await sync("2026-05-01T00:00:00.000Z", "2026-05-03T00:00:00.000Z");
    expect(run.body.status).toBe("succeeded");
    expect(clock.sleeps).toEqual([12_000]);
    expect(clock.now().getTime() - before).toBe(12_000);
    expect(run.body.attempts).toEqual([expect.objectContaining({ attempt: 1, waited_ms: 12_000 })]);
  });

  it("Retry-After acima do teto não espera: encerra como rate_limited e informa quando tentar", async () => {
    provider.failNext({ kind: "rate_limited", retryAfterMs: 120_000 });
    const run = await sync("2026-05-01T00:00:00.000Z", "2026-05-03T00:00:00.000Z");
    expect(run.body.status).toBe("rate_limited");
    expect(clock.sleeps).toEqual([]);
    expect(run.body.retry_at).toBe("2026-06-01T12:02:00.000Z");
  });

  it("429 seguidos respeitam o teto de tentativas", async () => {
    provider.failNext(...Array.from({ length: 10 }, () => ({ kind: "rate_limited" as const, retryAfterMs: 1_000 })));
    const run = await sync("2026-05-01T00:00:00.000Z", "2026-05-03T00:00:00.000Z");
    expect(run.body.status).toBe("failed");
    expect(provider.calls).toBe(4);
    expect(clock.sleeps).toEqual([1_000, 1_000, 1_000]);
  });

  it("converte Retry-After em segundos e em data HTTP", () => {
    const now = new Date(T0);
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("Mon, 01 Jun 2026 12:00:45 GMT", now)).toBe(45_000);
    expect(parseRetryAfter("lixo", now)).toBeNull();
  });
});

describe("quando a métrica foi buscada", () => {
  it("cada post guarda first_seen_at e fetched_at; o sync guarda início e fim", async () => {
    await sync("2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z");
    clock.advance(3_600_000);
    await sync("2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z");
    const { body } = await metrics();
    expect(body.posts[0]).toMatchObject({ first_seen_at: T0, fetched_at: "2026-06-01T13:00:00.000Z" });
    expect(body.last_fetched_at).toBe("2026-06-01T13:00:00.000Z");
    const syncs = await json<{ syncs: Array<{ started_at: string; finished_at: string }> }>(
      app.request(`/connections/${connectionId}/syncs`),
    );
    expect(syncs.body.syncs).toHaveLength(2);
    expect(syncs.body.syncs[0]?.started_at).toBe("2026-06-01T13:00:00.000Z");
  });
});

describe("concorrência e validação", () => {
  it("não roda dois syncs da mesma conexão ao mesmo tempo", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = provider.listPosts.bind(provider);
    provider.listPosts = async (input) => {
      await gate;
      return original(input);
    };
    const first = sync("2026-05-01T00:00:00.000Z", "2026-05-03T00:00:00.000Z");
    const second = await sync("2026-05-02T00:00:00.000Z", "2026-05-04T00:00:00.000Z");
    expect(second.status).toBe(409);
    release();
    expect((await first).body.status).toBe("succeeded");
  });

  it("valida janela e conexão", async () => {
    expect((await sync("2026-05-03T00:00:00.000Z", "2026-05-01T00:00:00.000Z")).status).toBe(400);
    expect((await app.request("/connections/con_x/metrics")).status).toBe(404);
  });
});
