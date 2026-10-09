# Métricas das redes do criador

Serviço que recebe uma conexão já autorizada (Instagram, TikTok, YouTube ou X) e sincroniza views, curtidas e comentários dos posts. O provedor é simulado. Os testes cobrem idempotência com janelas sobrepostas, retry com teto e 429 com `Retry-After`, tudo com relógio controlado.

## Como rodar

Node 22 ou mais novo.

```bash
npm install
npm test
npm run dev   # http://127.0.0.1:3004, com o provedor simulado e 3 posts de exemplo
```

```bash
curl -s -X POST localhost:3004/connections -H 'content-type: application/json' \
  -d '{"platform":"instagram","account_id":"ig_ana","access_token":"fake"}'
# → 201 {"id":"con_…","platform":"instagram","account_id":"ig_ana"}

curl -s -X POST localhost:3004/connections/con_…/syncs -H 'content-type: application/json' \
  -d '{"since":"2026-05-01T00:00:00.000Z","until":"2026-05-03T00:00:00.000Z"}'
# → 200 {"status":"succeeded","provider_calls":1,"posts_new":2,"posts_updated":0,"posts_unchanged":0,"attempts":[],…}

curl -s localhost:3004/connections/con_…/metrics
# → {"totals":{"views":6600,…},"last_fetched_at":"…","posts":[{"post_id":"p1","views":1200,"first_seen_at":"…","fetched_at":"…"},…]}
```

| Rota | O que faz |
|---|---|
| `POST /connections` | Registra (ou atualiza o token de) uma conta autorizada. O token nunca volta nas respostas. |
| `POST /connections/:id/syncs` | Sincroniza os posts publicados em `[since, until)`. Responde 200 se deu certo e 502 se falhou ou foi limitado, sempre com o registro do sync. |
| `GET /connections/:id/syncs` | Histórico de syncs: janela, status, chamadas, tentativas, esperas, erro e `retry_at`. |
| `GET /connections/:id/metrics` | Totais e posts com os números mais recentes, `first_seen_at`, `fetched_at` e `last_fetched_at`. |
| `GET /connections/:id/posts/:postId/snapshots` | Histórico das leituras de um post. |

## Onde fica cada coisa

```
src/providers/provider.ts       contrato do provedor + erros (RateLimited, Transient, Permanent) + parseRetryAfter
src/providers/fake-provider.ts  provedor simulado: paginação, falhas programadas, post repetido na resposta
src/retry.ts                    política de retry: backoff, Retry-After, teto de tentativas e de espera
src/sync.ts                     regra de negócio: paginação, gravação idempotente, registro do sync
src/clock.ts                    relógio real e relógio de teste (sleep não espera, só avança)
src/app.ts                      HTTP
```

A regra de negócio (`sync.ts`) só conhece a interface `MetricsProvider` e três tipos de erro. Um adaptador real de Instagram, TikTok etc. traduziria a resposta HTTP para `ProviderPage`, e 429/timeout/401 para esses erros. O simulado faz o mesmo em memória.

## Idempotência

- **A identidade de um post é `(conexão, post_id da rede)`**, chave primária de `posts`. Receber o mesmo post de novo, na mesma resposta, numa página repetida ou numa janela que se sobrepõe à anterior, faz um *upsert*: os números são **substituídos** pelos mais recentes, nunca somados. Os totais são a soma dos valores atuais de cada post, então um post nunca entra duas vezes.
- **Histórico sem duplicata:** `metric_snapshots` tem a chave `(conexão, post, snapshot_key)`. Se a rede informa quando mediu (`observed_at`), essa é a chave; senão, a chave são os próprios números. A mesma leitura repetida cai no `INSERT OR IGNORE`, e só uma leitura diferente vira linha nova.
- **Resposta atrasada não volta no tempo:** se chega uma medição com `observed_at` mais antigo que o guardado, ela fica no histórico mas não sobrescreve o número atual.
- **Cada página é gravada numa transação.** Se o sync cai no meio da paginação, o que já foi gravado fica consistente, e o próximo sync da mesma janela completa sem duplicar. Isso está testado.
- **Um sync por conexão de cada vez:** um índice único parcial em `sync_runs (connection_id) WHERE status = 'running'` faz o segundo sync concorrente receber 409.

## Retry, 429 e limite de taxa

Política padrão (`DEFAULT_RETRY`): até 4 tentativas por chamada ao provedor, backoff de 500 ms × 2ⁿ e teto de espera de 60 s.

- **Timeout ou 5xx:** novo retry com backoff exponencial (500, 1000, 2000 ms…), limitado pelo teto de espera. Na 4ª falha o sync termina como `failed`, com cada tentativa registrada.
- **429 com `Retry-After`:** o serviço espera **exatamente** o prazo pedido (aceita segundos ou data HTTP) e tenta de novo. As tentativas por 429 contam no mesmo teto.
- **`Retry-After` maior que o teto de espera:** o serviço não espera. O sync termina como `rate_limited`, com `retry_at` dizendo quando a rede libera. Assim nenhum worker fica preso por minutos e quem agenda decide quando voltar.
- **401/403:** sem retry, porque tentar de novo não resolve.

Nos testes, o `FakeClock` registra cada `sleep`. Por exemplo, `expect(clock.sleeps).toEqual([12_000])` prova que o serviço esperou o `Retry-After` de 12 s, nem mais nem menos.

## Quando a métrica foi buscada

- `posts.fetched_at` guarda a última vez que o post veio do provedor; `first_seen_at`, a primeira.
- `observed_at` é quando a rede diz ter medido, se ela informar.
- `metrics.last_fetched_at` é a leitura mais recente da conexão.
- Cada `sync_run` guarda `started_at`, `finished_at`, a janela, as chamadas, as tentativas com o tempo de espera e o erro.

## O que ficou de fora

- **OAuth real e renovação de token.** O token é guardado em texto puro. Em produção, ele ficaria cifrado (KMS) e o 401 dispararia a renovação.
- **Agendamento:** os syncs são disparados por HTTP. Em produção, uma fila (por exemplo, um job por conexão) chamaria `SyncService.sync` e respeitaria o `retry_at`.
- **Limite de taxa por app:** hoje o limite é tratado por chamada. Com muitas conexões na mesma rede, um token bucket compartilhado evitaria tomar 429.
- **Post apagado na rede:** hoje ele continua com o último número conhecido. O certo seria marcá-lo como removido quando some de uma janela que foi sincronizada por completo.
- **Paginação por cursor da rede:** o cursor não é persistido. Um sync que falha recomeça a janela, o que é seguro (idempotente), mas refaz chamadas.
- **SQLite em memória ou arquivo.** Com várias instâncias, o lock de "um sync por conexão" iria para o banco compartilhado ou para um lock distribuído.

## Uso de IA

Usei IA (Claude Code) pra me ajudar a entender o problema, analisar as regras e implementar a solução. Revisei o código, as decisões descritas aqui e rodei os testes pra confirmar.
