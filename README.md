# Jungle Gaming — Wagering Service

Serviço financeiro distribuído que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) recebidas por HTTP e por SQS. Ele continua correto com mensagens duplicadas, fora de ordem e processadas ao mesmo tempo por várias instâncias.

**Stack:** Bun 1.x · TypeScript (strict) · NestJS 11 · PostgreSQL 16 · TypeORM · AWS SQS via LocalStack · Docker Compose.

> As decisões técnicas, os trade-offs e as limitações estão em **[ARCHITECTURE.md](./ARCHITECTURE.md)**.
> Resultados e análise do teste de carga em **[LOAD_TEST.md](./LOAD_TEST.md)** (`bun run test:load`).

## Destaques

- **Dinheiro sem `number`:** `Money` usa `bigint` em centavos; no banco é `NUMERIC(19,2)`; no contrato é string `"25.00"`.
- **Concorrência:** lock pessimista **por wallet** (`SELECT ... FOR UPDATE`) + checagem de `version` + `CHECK (balance >= 0)`. Não existe lock global.
- **Idempotência persistente:** `UNIQUE(idempotency_key)` + `payloadHash` (SHA-256 de JSON canônico). Replay devolve o resultado original; payload diferente gera `409`.
- **Atomicidade:** transação, saldo, ledger, inbox e outbox no **mesmo commit**.
- **Ledger imutável** e **transações terminais imutáveis**, garantidos por trigger no banco.
- **SQS:** inbox persistente, ack só depois do commit, retry com backoff, DLQ e graceful shutdown.
- **Outbox:** vários publishers com `FOR UPDATE SKIP LOCKED` + lease. Se um morrer, outro assume.
- **Teste de carga:** 1.402 req/s distribuído, 231 req/s numa hot wallet, 0% de erro, saldo == ledger nas 202 wallets ([LOAD_TEST.md](./LOAD_TEST.md)).
- **Testes reais:** 120 testes (+ 31 E2E com Playwright), incluindo **3 processos simultâneos** com uma instância levando `SIGKILL` no meio da carga.

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker + Docker Compose

> O Postgres do compose fica exposto na porta **5433** do host (para não conflitar com um PostgreSQL local na 5432). O LocalStack fica na **4566**.

## Rodando tudo com Docker Compose (3 instâncias)

```bash
docker compose up -d --build
```

Isso sobe `postgres`, `localstack`, `migrate` (roda as migrations uma vez) e **3 réplicas** do `app` nas portas **3000, 3001 e 3002**. Cada réplica roda HTTP + consumer SQS + publisher da outbox + worker de referências pendentes.

**Documentação interativa (Swagger UI):** http://localhost:3000/docs. Dá para testar todos os endpoints pelo navegador ("Try it out").

```bash
curl http://localhost:3000/health/ready
```

> No Windows PowerShell use `curl.exe` (o `curl` puro é um alias de `Invoke-WebRequest`).

```bash
docker compose logs -f app
```

```bash
docker compose down -v
```

## Rodando localmente (desenvolvimento)

```bash
bun install
```

```bash
bun run infra:up
```

```bash
bun run migration:run
```

```bash
bun run start
```

As filas SQS são criadas automaticamente quando a aplicação sobe.

## Testes

Os testes de integração usam **PostgreSQL e LocalStack reais** (banco `wagering_test`, criado pelo compose). Suba a infra antes:

```bash
bun run infra:up
```

```bash
bun test
```

```bash
bun run test:unit
```

```bash
bun run test:integration
```

```bash
bun run typecheck
```

**E2E com Playwright** (caixa-preta, contra as 3 réplicas do Docker Compose: contrato HTTP, idempotência e concorrência entre instâncias, e o Swagger UI no navegador):

```bash
docker compose up -d --build --wait
```

```bash
bunx playwright install chromium
```

```bash
bun run test:e2e
```

O pipeline de CI (`.github/workflows/ci.yml`) roda tudo isso a cada push: typecheck → unidade → integração → 3 réplicas → E2E.

| Arquivo | O que prova |
|---|---|
| `test/unit/*` | Money, Wallet, ledger, regras por operação, transições, payloadHash, outbox |
| `test/integration/database.test.ts` | migrations reversíveis, cada constraint/trigger, atomicidade, reconciliação |
| `test/integration/wagering-rules.test.ts` | regras de negócio ponta a ponta, replay, conflitos, referência fora de ordem |
| `test/integration/concurrency.test.ts` | 2×80 com saldo 100, 50× a mesma aposta, hot wallet, wallets em paralelo |
| `test/integration/messaging.test.ts` | inbox, redelivery, crash após commit, DLQ, retry, shutdown, 2 publishers |
| `test/integration/multi-instance.test.ts` | 3 processos reais, SIGKILL + reinício, consistência eventual |

## Migrations

```bash
bun run migration:run
```

```bash
bun run migration:revert
```

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet (saldo inicial gera OPENING + CREDIT) |
| `GET` | `/wallets/:walletId` | consulta wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | ledger paginado (cursor opaco) |
| `POST` | `/wallets/:walletId/reconciliation` | saldo armazenado × saldo do ledger |
| `POST` | `/wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| `GET` | `/health/live` · `/health/ready` | liveness · readiness (PostgreSQL + SQS) |
| `GET` | `/metrics` | métricas Prometheus |

Status HTTP: `201` processada · `200` replay · `202` pendente de referência · `400` payload inválido · `404` não encontrado · `409` conflito de idempotência · `422` rejeição de negócio (`failureCode`) · `503` falha transitória (pode reenviar). Detalhes em ARCHITECTURE.md §8.

### Exemplo

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

```bash
curl -s -X POST localhost:3001/wagering/transactions -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:tx-1' -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<WALLET_ID>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'
```

### Mensagem SQS (`wager-transactions.fifo`)

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Use `MessageGroupId = walletId`. Eventos de integração são publicados na fila `wallet-events`.

## Configuração (variáveis de ambiente)

| Variável | Padrão |
|---|---|
| `PORT` | `3000` |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5433/wagering` |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` |
| `DB_LOCK_TIMEOUT_MS` | `5000` |
| `CONSUMER_MAX_RECEIVES` | `5` |
| `OUTBOX_LEASE_MS` | `30000` |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` (backoff 2s → 5min, ≈ 18 min) |
| `LOG_LEVEL` | `info` |

A lista completa está em `src/config.ts`.

## Estrutura

```
src/
  domain/           Money, Wallet, WagerTransaction, Ledger, Inbox/Outbox, eventos (sem NestJS/ORM)
  application/      use cases, regras de decisão, idempotência, contratos
  application/ports.ts   portas (interfaces) que a infraestrutura implementa
  infrastructure/   adaptadores: PostgreSQL (TypeORM, migrations, repositórios), SQS
  shared/           observabilidade: logs estruturados e métricas
  http/             controllers, mapeamento de erros, guard de autenticação (ponto de extensão)
test/
  unit/  integration/  helpers/
```
