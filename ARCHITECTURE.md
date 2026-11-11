# ARCHITECTURE.md

Decisões técnicas, trade-offs e limitações do serviço de processamento de apostas.

---

## 1. Visão geral

```
               HTTP (POST /wagering/transactions)         SQS (wager-transactions.fifo)
                          │                                          │
                          ▼                                          ▼
                 WageringController                            WagerConsumer
                          │                                (inbox + classificação de erros)
                          └──────────────┬───────────────────────────┘
                                         ▼
                           SubmitWagerTransaction (use case único)
                                         │
             ┌─────────── 1 transação SQL (READ COMMITTED) ────────────┐
             │ SELECT wallet FOR UPDATE  (lock da LINHA da wallet)      │
             │ INSERT inbox  (se veio da fila)                          │
             │ idempotência (UNIQUE idempotency_key + payloadHash)      │
             │ decide → WagerTransaction + Wallet + LedgerEntry         │
             │ INSERT transação / ledger · UPDATE saldo (com version)   │
             │ INSERT outbox (eventos)                                  │
             └──────────────────────── COMMIT ──────────────────────────┘
                                         │
              OutboxPublisher (N instâncias, SKIP LOCKED + lease) ──► SQS wallet-events
              PendingReferenceWorker (N instâncias) ──► reprocessa PENDING_REFERENCE
```

Cada instância da aplicação roda tudo: HTTP, consumer SQS, publisher da outbox e worker de referências. Não existe nenhum estado em memória que importe para a correção: **o PostgreSQL é a fonte da verdade e a última linha de defesa**. Por isso dá para subir N réplicas idênticas (o `docker-compose.yml` sobe 3).

### Camadas: portas e adaptadores (arquitetura hexagonal)

```
   http/ (NestJS)      infrastructure/messaging (SQS)          ← adaptadores de ENTRADA
            │                   │
            ▼                   ▼
   ┌──────────────── application/ ────────────────┐
   │ use cases · settleAndPersist · contratos     │
   │ ports.ts  ← UnitOfWork, *Repository (interfaces)
   └──────────────────────┬───────────────────────┘
                          ▼
   ┌───────────────── domain/ ────────────────────┐
   │ Money · Wallet · WagerTransaction · Ledger   │   ← nenhuma dependência externa
   │ settleWager (serviço de domínio PURO)        │
   └──────────────────────────────────────────────┘
                          ▲ implementa as portas
   infrastructure/database (PgUnitOfWork, Pg*Repository)   ← adaptadores de SAÍDA
```

| Pasta | Conteúdo | Depende de |
|---|---|---|
| `src/domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos, erros e o serviço de domínio **`settleWager`** | nada (nem NestJS, nem ORM, nem I/O) |
| `src/application` | use cases, orquestração (`settleAndPersist`), hash de payload, contratos (zod) e as **portas** (`ports.ts`) | domínio + portas |
| `src/infrastructure` | **adaptadores**: `PgUnitOfWork` e `Pg*Repository` (TypeORM/PostgreSQL, migrations), SQS (consumer, publisher) | portas + libs externas |
| `src/http` | controllers, filtro de erros, Swagger, guard de autenticação (no-op) | application |
| `src/shared` | observabilidade (logs estruturados e métricas), um assunto transversal | — |

**Regra de dependência:** `domain` não importa ninguém, e `application` só importa `domain` e as próprias portas. Nenhum arquivo de `application/` ou `domain/` importa `infrastructure/` (dá para conferir com `grep -rn "infrastructure" src/application src/domain`). Detalhes de persistência ficam no adaptador: SQL, códigos de erro do PostgreSQL, retry de corrida, cursor de paginação e tradução de `unique violation` para `WALLET_ALREADY_EXISTS`.

**Por que isso importa aqui:**
- **As regras de liquidação são uma função pura** (`settleWager(wallet, tx, referenceContext, now, policy)`). Ela é testada sem banco em `test/unit/wager-settlement.test.ts`, e os mesmos cenários rodam também contra PostgreSQL real nos testes de integração.
- **O fluxo de liquidação tem três passos explícitos:** carregar o contexto (portas) → decidir (domínio puro) → persistir transação, ledger, saldo e outbox (portas, mesmo commit).
- **Trocar a persistência** (por exemplo, migrar para MikroORM) significa escrever novos adaptadores das mesmas interfaces, sem tocar em use case.

O domínio usa **construtor privado + factories** (`create`/`open`/`from`/`rehydrate`). O `rehydrate` só reconstrói estado persistido, sem revalidar transições.

---

## 2. ORM e persistência — TypeORM

**Escolha:** TypeORM (aceito pelo desafio). Escolhi por ter mais familiaridade com ele, já que o prazo era curto.

**Como foi usado:** o TypeORM cuida de `DataSource`, pool de conexões, `QueryRunner` (transações) e **migrations versionadas e reversíveis** (`up`/`down`). Não uso entidades decoradas nem o Unit of Work do ORM. Os repositórios (`src/infrastructure/database/repositories.ts`) são **mapeadores manuais com SQL explícito**. Motivos:

1. O domínio fica puro: nenhuma classe de domínio tem decorator ou tipo do ORM.
2. O que mais importa aqui (`FOR UPDATE`, `SKIP LOCKED`, `ON CONFLICT DO NOTHING`, `UPDATE ... WHERE version = $n`) fica **visível no código**, e não escondido atrás de uma abstração.
3. Fica fácil de raciocinar sobre a ordem de locks (sempre wallet → transação).

**Trade-off:** escrevo mais SQL à mão e não tenho identity map. O MikroORM (preferencial) daria `em.transactional()` e `LockMode.PESSIMISTIC_WRITE` prontos. Eu migraria para ele com mais tempo.

**Estratégia transacional:** a porta `UnitOfWork.transaction(work)` é implementada por `PgUnitOfWork`. Ele abre uma transação `READ COMMITTED`, define `SET LOCAL lock_timeout` e entrega ao `work` um conjunto de repositórios **ligados à mesma conexão**. Ou tudo faz commit junto (transação, saldo, ledger, inbox, outbox), ou nada é gravado. O adaptador também é responsável pelo contrato de erros da porta:
- **corridas entre instâncias** (lock timeout, deadlock, conflito de versão, unique de idempotência ou de inbox) são re-tentadas até 4 vezes, cada vez numa transação nova;
- **esgotado o limite, ou com o banco indisponível**, o erro sai como `TransientInfrastructureError` (vira `503` no HTTP e retry com backoff no SQS);
- **erros de domínio** saem intactos.

### Mapeamento do Money

- **Em memória:** `bigint` em centavos (`Money` guarda `cents: bigint` + `currency`). Não existe `number` em nenhum ponto do caminho do dinheiro.
- **No banco:** duas colunas, `amount numeric(19,2)` + `currency char(3)`. O driver `pg` devolve `numeric` como **string**, e `Money.fromDatabase` faz o parse sem passar por float.
- **No contrato:** `{ "amount": "25.00", "currency": "BRL" }`.

Por que `bigint` e não uma lib decimal? A escala é fixa (2 casas) e só faço soma, subtração e comparação. Com inteiros de precisão arbitrária a aritmética é exata, sem dependência e sem arredondamento. **Entradas com mais de 2 casas são rejeitadas, nunca arredondadas.** Se um dia precisar de multiplicação (juros, câmbio), aí entraria uma lib decimal com modo de arredondamento explícito.

---

## 3. Schema: invariantes garantidas pelo banco

Migration: `src/infrastructure/database/migrations/1762800000000-InitialSchema.ts`.

| Invariante | Como o banco garante |
|---|---|
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets`; `CHECK (balance_before >= 0 AND balance_after >= 0)` no ledger |
| 1 wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Idempotência persistente | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| 1 lançamento por wallet/transação | `UNIQUE (wallet_id, transaction_id)` no ledger |
| Lançamento fecha a conta | `CHECK` de `balance_after = balance_before ± amount` conforme a direção |
| Ledger imutável | trigger `trg_ledger_append_only` bloqueia `UPDATE` e `DELETE` |
| Transação terminal imutável | trigger `trg_wager_tx_terminal_immutable` bloqueia alteração de linhas `PROCESSED`/`REJECTED`/`FAILED` |
| Referência revertida uma vez só | índice único parcial `uq_wager_tx_single_reversal` em `reference_transaction_id` para `REFUND`/`ROLLBACK` processados |
| `REFUND`/`ROLLBACK` têm referência | `CHECK` por `kind` |
| `REJECTED`/`FAILED` têm `failure_code` (e só eles) | `CHECK` |
| Inbox | `PRIMARY KEY (consumer_name, message_id)` |

Os testes de integração (`test/integration/database.test.ts`) violam cada constraint diretamente via SQL para provar que o banco recusa.

---

## 4. Concorrência

**Unidade de concorrência:** a `walletId`.

**Estratégia: lock pessimista da linha da wallet** (`SELECT ... FROM wallets WHERE id = $1 FOR UPDATE`) no começo da transação, mais três camadas de defesa:

1. **Lock por linha, não global:** operações da mesma wallet são serializadas pelo PostgreSQL; wallets diferentes rodam em paralelo.
2. **Optimistic check como cinto de segurança:** o `UPDATE wallets ... WHERE id = $1 AND version = $esperada` precisa afetar 1 linha. Se não afetar, aborta (nunca deveria acontecer com o lock, mas pega bugs).
3. **`CHECK (balance >= 0)`:** mesmo que tudo acima falhe, o banco recusa saldo negativo.
4. **`lock_timeout` (5s) + retry limitado (4 tentativas com jitter):** lock timeout, deadlock e serialization failure viram retry. Esgotado o limite, o erro é transitório: `503` no HTTP ou volta para a fila com backoff no SQS. Cada conflito incrementa `wager_lock_conflicts_total`.

**Por que pessimista e não optimistic puro?** Em iGaming existem *hot wallets* (um jogador com várias rodadas simultâneas). Com optimistic locking, sob contenção, a maioria das tentativas falha e re-tenta, o que gera latência imprevisível e retries esgotados. Com lock pessimista a fila de espera é do próprio PostgreSQL e o tempo de lock é curto (poucas queries por transação).

**Por que não só `UPDATE ... SET balance = balance - x WHERE balance >= x`?** Funciona para o débito isolado, mas cada movimento precisa também gravar `balance_before`/`balance_after` no ledger e validar referências (REFUND/ROLLBACK) de forma consistente. Isso exige ler e decidir com a wallet travada.

**Ordem de locks:** sempre `wallet → wager_transaction` (submissão e worker de referências), o que evita deadlock entre eles.

**Broker:** a fila FIFO usa `MessageGroupId = walletId`, o que reduz a contenção (mensagens da mesma wallet chegam em ordem para um consumidor). Isso é **só otimização**: os testes mandam mensagens duplicadas com `MessageDeduplicationId` diferentes e provam que o banco segura sozinho.

**Cenário obrigatório** (100.00, duas apostas de 80.00 simultâneas) é testado de duas formas: com 2 conexões paralelas no mesmo processo (`concurrency.test.ts`) e via HTTP em 2 instâncias diferentes (`multi-instance.test.ts`). Resultado nos dois casos: 1 `PROCESSED`, 1 `REJECTED INSUFFICIENT_FUNDS`, saldo 20.00, um único DEBIT.

---

## 5. Idempotência

- **Fonte da verdade:** header `Idempotency-Key` (obrigatório, 1–255 chars). Na fila, `data.idempotencyKey`. Padrão recomendado: `{providerId}:{externalTransactionId}`.
- **payloadHash:** `SHA-256` em hex do **JSON canônico** dos campos de negócio:
  `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId?`
  - chaves ordenadas recursivamente; sem espaços; campos `undefined` omitidos;
  - `amount` normalizado antes (`"25.5"` → `"25.50"`), para que o mesmo valor gere o mesmo hash;
  - **ficam de fora:** o header, `correlationId`, `messageId`, `occurredAt` e qualquer metadado de transporte.
  - Implementação: `src/application/payload-hash.ts`.
- **Replay:** mesma key + mesmo hash devolve a transação original, com `idempotentReplay: true` e o **saldo observado naquele momento** (coluna `result_balance`), não o saldo atual.
- **Conflito:** mesma key + hash diferente → `409 IDEMPOTENCY_KEY_CONFLICT`. Mesmo `(providerId, externalTransactionId)` com outra key → `409 EXTERNAL_TRANSACTION_CONFLICT`.
- **Corrida entre instâncias:** a checagem é refeita **com a wallet travada**. Se duas instâncias processarem a mesma key em wallets diferentes (payload divergente), o `UNIQUE` estoura na segunda. O retry repete a transação, que então cai no caminho de replay ou conflito.
- **Nada em memória.** O atalho de replay (consulta antes de travar a wallet) também lê do banco.

---

## 6. Máquina de estados de `WagerTransaction`

```
PENDING ──► PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
PENDING_REFERENCE ──► PROCESSED | REJECTED | PENDING_REFERENCE (reagendamento) | FAILED
PROCESSED | REJECTED | FAILED  →  terminais (InvalidTransactionStateError)
```

- `PENDING` só existe em memória, dentro da transação SQL: a decisão acontece antes do `INSERT`, por isso o schema nem aceita `PENDING`.
- `FAILED` = erro permanente **inesperado** ao reprocessar uma `PENDING_REFERENCE` (bug ou dado corrompido): a transação é encerrada como `FAILED PROCESSING_FAILED` em vez de ficar em loop eterno. Continua auditável.
- Tentar transicionar um estado terminal lança `InvalidTransactionStateError` (erro de programação), e o trigger do banco também impede.

---

## 7. Regras de negócio e interpretações adotadas

| Operação | Saldo | Ledger | Observações |
|---|---|---|---|
| BET | débito | 1 DEBIT | sem saldo → `REJECTED INSUFFICIENT_FUNDS` |
| WIN | crédito | 1 CREDIT | `referenceExternalTransactionId` opcional; se vier, precisa ser uma BET válida da rodada |
| LOSS | — | — | `PROCESSED`, sem lançamento; único kind que aceita valor `0.00` |
| REFUND | crédito | 1 CREDIT | só referencia BET `PROCESSED`, mesmo valor |
| ROLLBACK | inverso da referência | 1 lançamento invertido | referencia BET (→ CREDIT), WIN ou REFUND (→ DEBIT) |

Interpretações que **eu** adotei (o enunciado deixa espaço):

1. **Uma referência só pode ser revertida uma vez no total**, seja por REFUND ou por ROLLBACK. O enunciado fala em "mesmo tipo de operação", mas permitir REFUND **e** ROLLBACK da mesma BET creditaria o valor duas vezes. Preferi a regra mais segura financeiramente. Para desfazer um REFUND indevido, faz-se ROLLBACK **do REFUND**, que é permitido e debita. Garantido também pelo índice único parcial.
2. **A referência precisa ser do mesmo provider** (além de player, wallet, rodada e moeda), porque é resolvida por `(providerId, referenceExternalTransactionId)`.
3. **Referência em `PENDING_REFERENCE`** (ex.: ROLLBACK de um WIN que ainda espera a BET) é tratada como "ainda não disponível": a transação também espera.
4. **Referência `REJECTED`/`FAILED`** → `REFERENCE_NOT_PROCESSED` (terminal, não espera).
5. **BET e LOSS com referência** → payload inválido (400).
6. **Valores zero:** só LOSS aceita `0.00`; os demais exigem valor > 0, porque um lançamento de ledger de valor zero não faz sentido (`CHECK amount > 0`).
7. **Wallet inexistente** → `404 WALLET_NOT_FOUND`, sem persistir nada (não há wallet para auditar). Player diferente do dono da wallet → transação `REJECTED PLAYER_WALLET_MISMATCH`, persistida para auditoria.
8. **Reversão sem saldo** (ex.: ROLLBACK de WIN depois que o jogador gastou) → `REJECTED REVERSAL_INSUFFICIENT_FUNDS`, código diferente de `INSUFFICIENT_FUNDS` por ser situação operacional diferente (exige ação manual).

### 7.1 Referências fora de ordem

- Referência ausente → transação persistida como `PENDING_REFERENCE`, com `next_attempt_at` e evento `WagerTransactionPendingReference` (só no primeiro adiamento).
- O `PendingReferenceWorker` (em todas as instâncias) busca as vencidas e reprocessa cada uma em sua própria transação: trava wallet → trava transação → re-checa status e `next_attempt_at`. Se outra instância já tratou, pula. Os testes rodam 3 workers simultâneos sobre a mesma pendência.
- **Backoff exponencial:** `2s × 2^n`, com teto de 5 min.
- **Limite: 10 tentativas (≈ 18 minutos no total).** Justificativa: referências fora de ordem acontecem por reordenação/redelivery do broker ou por instabilidade curta no provedor, coisa de segundos a poucos minutos. 18 minutos cobrem uma indisponibilidade razoável do SQS ou do PostgreSQL sem deixar transação "pendurada" por horas, o que travaria a conciliação do provedor. Tudo é configurável por env (`PENDING_REFERENCE_*`).
- Esgotado o limite → `REJECTED REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.

### 7.2 Códigos de falha

| failureCode | Quando | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | desistir |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK que deixaria saldo negativo | escalar para tratamento manual |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | corrigir o payload |
| `PLAYER_WALLET_MISMATCH` | player não é dono da wallet | corrigir o payload |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite | reenviar referência e depois a operação com **nova** key |
| `REFERENCE_MISMATCH` | referência de outro provider/player/wallet/rodada/moeda | corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | ex.: REFUND de um WIN | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | referência foi rejeitada | desistir |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida | desistir (já foi feito) |
| `AMOUNT_MISMATCH` | valor ≠ valor da referência | corrigir (reversão parcial não suportada) |
| `PROCESSING_FAILED` | (`FAILED`) erro interno permanente | abrir incidente |

Erros de **validação** (antes de virar transação) usam `error.code` na resposta: `INVALID_PAYLOAD`, `INVALID_MONEY`, `REFERENCE_REQUIRED`, `REFERENCE_NOT_ALLOWED`, `INVALID_AMOUNT`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_ID`, `INVALID_CURSOR`.

---

## 8. API HTTP: mapeamento de status

O mesmo mapeamento vale para todos os endpoints (`src/http/error-filter.ts` + `statusFor` em `controllers.ts`):

| Situação | Status | Pode reenviar? |
|---|---|---|
| `PROCESSED` (primeira vez) | `201` | — |
| `PROCESSED` (replay) | `200` + `idempotentReplay: true` | — |
| Aceito, processamento pendente (`PENDING_REFERENCE`) | `202` | consultar depois |
| Rejeição de regra de negócio (`REJECTED`) | `422` + `failureCode` | não (ou corrigir) |
| Payload inválido | `400` | não, corrigir |
| Recurso inexistente | `404` | não |
| Conflito de idempotência / wallet duplicada | `409` | não |
| Falha transitória de infraestrutura (banco fora, lock timeout esgotado) | `503` + `Retry-After` | **sim, a mesma requisição** |
| Erro inesperado | `500` | com cautela (é idempotente) |

O replay de uma transação `REJECTED` devolve `422` com `idempotentReplay: true`. Toda resposta de erro tem o formato `{ error: { code, message }, correlationId }`.

**Reconciliação** (`POST /wallets/:id/reconciliation`): trava a wallet com `FOR SHARE` (ninguém escreve entre as duas leituras), soma o ledger em `NUMERIC` no próprio banco e compara. Divergência **nunca é corrigida sozinha**: gera log `error`, incrementa `wallet_reconciliation_divergences_total` e volta `consistent: false`.

**Ledger** (`GET /wallets/:id/ledger`): paginação por keyset sobre `seq` (`bigserial`). O cursor é `base64url({"s":"<seq>"})`, opaco e estável mesmo com novos lançamentos entrando.

---

## 9. Processamento SQS

`src/infrastructure/messaging/wager-consumer.ts`

1. Long polling (até 10 mensagens). Mensagens são agrupadas por `MessageGroupId`: grupos diferentes em paralelo, mesmo grupo em sequência.
2. Valida o envelope (zod). Inválido → **DLQ** (`INVALID_MESSAGE`).
3. Chama **o mesmo use case do HTTP**, passando o contexto de inbox `(consumerName, messageId, payloadHash)`. O registro de inbox é gravado **dentro da mesma transação SQL** (`INSERT ... ON CONFLICT DO NOTHING`). Se já existia, é duplicata: não faz nada e confirma.
4. **Ack (`DeleteMessage`) só depois do commit.**
5. Classificação de erros:

| Tipo | Exemplos | Ação |
|---|---|---|
| Negócio (terminal) | transação `REJECTED`, `WALLET_NOT_FOUND`, conflito de idempotência | **ack** |
| Permanente | JSON inválido, dinheiro inválido (`1e3`), kind inválido | **DLQ** com atributo `reason` |
| Transitório / inesperado | PostgreSQL fora, lock timeout esgotado | **retry**: `ChangeMessageVisibility` com backoff `2s × 2^(n-1)`; na 5ª entrega → **DLQ** (`MAX_RECEIVES_EXCEEDED`) |

A fila principal também tem `RedrivePolicy` para a DLQ (`maxReceiveCount = 6`), como rede de segurança caso o processo morra em loop.

6. **SIGTERM:** `app.enableShutdownHooks()` → `beforeApplicationShutdown` para o polling (aborta o long poll), **termina as mensagens em andamento** e devolve as ainda não iniciadas com visibilidade `0`. Só depois fecha o pool do banco. O Docker Compose dá `stop_grace_period: 30s`.
7. **Worker morto entre commit e ack:** a mensagem volta após o visibility timeout, o inbox detecta a duplicata e apenas confirma. Teste: `messaging.test.ts`. No `multi-instance.test.ts` uma instância leva `SIGKILL` no meio da carga e é reiniciada.

---

## 10. Transactional Outbox

`src/infrastructure/messaging/outbox-publisher.ts`

- Eventos são gravados em `outbox_messages` **na mesma transação** do efeito financeiro. Por construção, nada é publicado antes do commit.
- **Claim com lease:** `UPDATE outbox_messages SET next_attempt_at = now() + lease WHERE id IN (SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now() ... FOR UPDATE SKIP LOCKED) RETURNING *`. Vários publishers nunca pegam a mesma linha no mesmo ciclo, e nenhum fica bloqueado esperando o outro.
- Publica em lote no SQS (`wallet-events`) **fora** da transação e marca `published_at`. Falha → `attempts++` e backoff exponencial (teto 60s).
- **Processo morre depois do claim:** o lease (30s) vence e outra instância publica. **Morre depois de publicar e antes de marcar:** o evento é publicado de novo (at-least-once). Duplicata é segura porque o `eventId` é estável (o id da linha da outbox é o próprio `eventId`, enviado também como `MessageAttribute`), e o consumidor deduplica por ele.
- Envelope: classe abstrata `IntegrationEvent<T>` com uma subclasse por evento (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`). `eventType` e `version` ficam no tipo, `occurredAt` sai em ISO-8601 e `data` só carrega `MoneyProps` (strings).
- A abertura da wallet (transação interna `OPENING`) também emite `WagerTransactionProcessed`, por ser uma transação aplicada, e `WalletBalanceChanged`, porque o saldo mudou.

---

## 11. Observabilidade

- **Logs JSON estruturados** (`src/infrastructure/observability/logger.ts`), com contexto propagado via `AsyncLocalStorage`: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` e `instance`. O `correlationId` vem do header `X-Correlation-Id` (ou é gerado) e é devolvido na resposta. **Não logo payload financeiro completo**: só ids, status e códigos. Os valores aparecem apenas no log de divergência de reconciliação, que é justamente o diagnóstico.
- **Métricas** em `GET /metrics` (formato Prometheus):

| Métrica | O que mede |
|---|---|
| `wager_transactions_total{kind,status,failure_code}` | transações por status |
| `wager_duplicates_total{source}` | duplicatas (idempotency key / inbox) |
| `wager_idempotency_conflicts_total` | key reutilizada com payload diferente |
| `wager_retries_total{where}` | retries (use case / sqs / pending_reference) |
| `wager_dlq_messages_total{reason}` | mensagens enviadas para a DLQ |
| `wager_lock_conflicts_total` | lock timeout, deadlock ou conflito de versão |
| `outbox_lag_seconds` | idade do evento pendente mais antigo |
| `outbox_published_total` / `outbox_publish_failures_total` | publicação |
| `wager_processing_latency_seconds{source}` | histograma de latência |
| `wallet_reconciliation_divergences_total` | divergências encontradas |

- **Health:** `GET /health/live` (processo de pé) e `GET /health/ready` (PostgreSQL **e** SQS alcançáveis; `503` caso contrário). Nenhum dos dois exige autenticação.

---

## 12. Autenticação: não implementada (decisão consciente)

Não vale pontos e competiria com o essencial no prazo. O ponto de extensão está explícito em `src/http/auth.ts`:

- `ProviderAuthGuard` (no-op), já aplicado nos controllers de wallet e wagering;
- `ProviderIdentityPort`, a porta que resolveria a identidade do provedor.

**Desenho que eu adotaria:** Keycloak no Docker Compose, um *client* OIDC por provedor de jogos com fluxo `client_credentials`. O guard valida o JWT (assinatura via JWKS do Keycloak, `iss`, `aud`, `exp`) e extrai o `providerId` de um claim. O use case passa a exigir `body.providerId === identity.providerId`, para que um provedor não mande transações em nome de outro. Health e `/metrics` continuam abertos (na prática `/metrics` ficaria só na rede interna). Mensagens SQS são canal interno confiável, mas o `providerId` delas continua passando pelas mesmas validações de domínio.

---

## 13. Testes

`bun test`: unidade + integração contra **PostgreSQL e LocalStack reais**. Nada de mock de banco ou fila. O único "dublê" é um use case que lança `ECONNREFUSED`, usado para provar retry e DLQ com o SQS real.

| Requisito | Onde |
|---|---|
| Money: escala, arredondamento (rejeição), inválidos, moedas | `test/unit/money.test.ts` |
| Invariantes da Wallet e do ledger | `test/unit/wallet.test.ts` |
| Regras por operação, transições, payload divergente | `test/unit/wager-transaction.test.ts` |
| Regras de liquidação (serviço de domínio puro `settleWager`), **sem banco** | `test/unit/wager-settlement.test.ts` |
| Migrations reversíveis + cada constraint/trigger | `test/integration/database.test.ts` |
| Atomicidade wallet/ledger/inbox/outbox (falha antes do commit) | `test/integration/database.test.ts` |
| Regras de negócio ponta a ponta, replay, conflitos, reconciliação, cursor | `test/integration/wagering-rules.test.ts` |
| 2×80 com saldo 100; 50× a mesma aposta; hot wallet; wallets distintas; reversões concorrentes; workers concorrentes | `test/integration/concurrency.test.ts` |
| Inbox e redelivery; worker morto após commit e antes do ack; DLQ; retry; shutdown; 2 publishers; publisher morto | `test/integration/messaging.test.ts` |
| **3 processos reais** (HTTP + SQS), SIGKILL e reinício no meio da carga, REFUND antes da BET, consistência eventual | `test/integration/multi-instance.test.ts` |

| Contrato HTTP de fora (caixa-preta), 2×80 e 50× a mesma aposta entre as 3 réplicas do compose, Swagger UI | `e2e/*.spec.ts` (Playwright) |

**Invariante final de TODOS os testes:** cada arquivo de integração tem um `afterEach` (`expectAllWalletsConsistent`) que confere, para **todas** as wallets do banco, `wallet.balance == saldo reconstruído pelo ledger` e saldo ≥ 0. Os E2E chamam a reconciliação ao final de cada cenário.

**Falha transitória real:** `concurrency.test.ts` segura o lock de uma wallet em outra conexão até estourar o `lock_timeout` → `TransientInfrastructureError` (`503`), nada gravado; reenviar a mesma requisição depois processa uma única vez. O mapeamento completo erro → status está em `test/unit/http-error-mapping.test.ts`.

---

## 14. Limitações conhecidas e próximos passos

Fui honesto sobre o que ficou de fora ou simplificado:

1. **Teste de carga feito, mas em uma única máquina** (ver [LOAD_TEST.md](./LOAD_TEST.md)): 1.402 req/s distribuído, 231 req/s numa hot wallet, 6.528 replays/s, 0% de erro e todas as wallets consistentes. Ele revelou e corrigiu dois problemas: outbox lenta (lag de 166 s → 6,7 s) e falha do `docker compose up` em ambiente zerado. Números de capacidade real exigiriam gerador, app e banco em máquinas separadas.
2. **Inbox com mesmo `messageId` e payload diferente** é ignorado (ack) com log `error` e a métrica `wager_inbox_payload_mismatch_total`. Não vai para a DLQ porque o efeito original já foi aplicado. É uma anomalia do produtor, a ser investigada.
3. **Métricas em memória por instância:** o Prometheus precisa raspar cada réplica. Sem OpenTelemetry/tracing.
4. **O worker de PENDING_REFERENCE faz polling.** Uma melhoria seria reavaliar imediatamente as pendências quando a referência chega (na mesma transação da BET), deixando o polling só como garantia.
5. **Outbox e inbox crescem para sempre.** Faltam job de limpeza e particionamento por data.
6. **Ledger de partida simples** (não double-entry).
7. **LocalStack fixado em `3.8.1`**: as imagens mais novas exigem token de conta. Se precisar, dá para trocar por MiniStack só mudando o endpoint.
8. **MikroORM** (preferencial) não foi usado. Ver §2. Com as portas, migrar significa só escrever novos adaptadores.
9. **O lock pessimista limita o throughput de uma única wallet** a uma transação por vez. É aceitável (um jogador não faz milhares de apostas por segundo) e é exatamente o que garante a correção.
