# LOAD_TEST.md: teste de carga

```bash
docker compose down -v && docker compose up -d --build --wait
```

```bash
bun run test:load
```

O script fica em `scripts/load-test.ts`; os resultados brutos ficam em `load-test/*.json`.

> **Resumo:** sob carga, **nenhuma** invariante financeira foi violada: 0% de erro, 0 saldo divergente do ledger em 202 wallets, 1 único débito em 130 mil replays. O teste revelou **dois problemas reais**, ambos corrigidos: (1) o publisher da outbox não acompanhava a produção de eventos (lag de até 166 s) e (2) o `docker compose up` em ambiente zerado falhava no container de migration.

---

## 1. Ambiente

| Item | Valor |
|---|---|
| Máquina | Desktop, Intel Core i5-12400F (6 núcleos / 12 threads), 16 GB RAM |
| SO | Windows 11 + Docker Desktop (WSL2) |
| Topologia | **3 réplicas** NestJS/Bun 1.4.4 + PostgreSQL 16 + LocalStack 3.8.1 (Docker Compose), **todos na mesma máquina** |
| Gerador de carga | Bun 1.4.4 (`fetch`), **na mesma máquina**, round-robin entre as 3 réplicas via `127.0.0.1:3000-3002` |
| Configuração | pool de 20 conexões por réplica, `lock_timeout` 5 s, outbox em lotes de 200 |

**Limitação importante:** gerador, aplicação, banco e LocalStack disputam a mesma CPU, e o Docker no Windows passa a rede por uma VM. Os números são **relativos** (para comparar cenários e versões), não uma previsão de capacidade em produção.

## 2. Metodologia

- **Modelo de carga fechado (closed-loop):** 64 workers concorrentes; cada um envia a próxima requisição assim que recebe a resposta da anterior. Throughput = requisições concluídas / tempo.
- **Duração:** 20 s por cenário, depois de criar 200 wallets com saldo 100.000,00.
- **Cenários:**

| Cenário | O que faz | Por quê |
|---|---|---|
| `distributed` | 200 wallets; 60% BET (1,00), 25% WIN (1,50), 5% LOSS; ~10% são **reenvios** de requisições já feitas | o caso normal de produção: muitas wallets, alguns retries de provedor |
| `hot-wallet` | todas as requisições na **mesma wallet** (70% BET / 30% WIN) | pior caso de contenção: mede o custo do lock pessimista por wallet |
| `replay-storm` | 1 requisição original e **todas** as seguintes são replays dela | custo da idempotência persistente (deduplicação) |

- **Métricas coletadas:**
  - latência ponta a ponta no cliente (p50/p95/p99/máx);
  - status HTTP; taxa de erro (5xx + falhas de rede);
  - deltas de `/metrics` somados das 3 réplicas: `wager_lock_conflicts_total`, retries da unidade de trabalho, duplicatas;
  - `outbox_lag_seconds` amostrado a cada 500 ms;
  - tempo para a outbox drenar depois da carga.
- **Validação de correção ao final:** `POST /wallets/:id/reconciliation` em **todas** as 202 wallets usadas. O ledger da wallet do replay-storm precisa ter exatamente 2 lançamentos (abertura + 1 débito).

## 3. Resultados (ambiente zerado, versão final)

| Cenário | Requisições | Throughput | p50 | p95 | p99 | Erros | Lock conflicts | Outbox lag máx. | Drenagem após a carga |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| distributed | 28.086 | **1.402 req/s** | 39,6 ms | 88,8 ms | 174,8 ms | **0%** | 0 | 6,7 s | 5,6 s |
| hot-wallet | 4.686 | **231 req/s** | 223 ms | 745 ms | 980 ms | **0%** | 0 | 1,6 s | 0,5 s |
| replay-storm | 130.626 | **6.528 req/s** | 9,1 ms | 17,0 ms | 21,5 ms | **0%** | 0 | 0 s | 0 s |

**Correção sob carga:** 202/202 wallets consistentes (`saldo == ledger`); 130.625 replays detectados e **1 único débito**; 0 retries da unidade de trabalho.

## 4. Análise

**Distribuído (1.402 req/s, p99 175 ms).** Com 200 wallets a chance de duas requisições disputarem a mesma linha é baixa, então o lock por wallet quase não aparece. O custo dominante é a própria transação: ~6 a 8 queries (lock, busca de idempotência, insert da transação, ledger, update de saldo e 2 eventos na outbox) + commit.

**Hot wallet (231 req/s, p99 ~1 s).** É o comportamento esperado do desenho: o `SELECT ... FOR UPDATE` **serializa** as operações da mesma wallet, então o throughput de uma wallet é ~1 / (duração da transação). Com 64 clientes na fila dessa única linha, o p99 reflete o tempo de espera na fila do lock. Pontos importantes:
- **0 lock conflicts e 0 retries:** ninguém estourou o `lock_timeout` (5 s); a espera fica na fila do PostgreSQL, sem retentativas desperdiçadas. Com optimistic locking, esse cenário viraria uma tempestade de conflitos e retries.
- Na prática, 64 apostas simultâneas no **mesmo jogador** não é um padrão realista; 231 operações/s por jogador sobra.
- Se fosse preciso mais, o caminho seria encurtar a transação (por exemplo, mover a busca de idempotência para antes do lock, o que já é feito no HTTP) ou agrupar operações da mesma wallet.

**Replay storm (6.528 req/s, p99 21 ms).** O replay é a operação mais barata: uma leitura por índice único (`idempotency_key`) **sem travar a wallet** (o atalho de replay roda antes do lock). Reenvios agressivos de provedores não competem com tráfego novo pelo lock.

## 5. Problemas encontrados pelo teste de carga (e corrigidos)

### 5.1 Outbox não acompanhava a produção de eventos

Primeira execução (`load-test/1-before-outbox-fix.json`):

| Cenário | Throughput | Outbox lag máx. | Drenagem |
|---|---:|---:|---:|
| distributed | 1.537 req/s | 17,3 s | > 60 s (timeout) |
| hot-wallet | 214 req/s | 92,9 s | > 60 s |
| replay-storm | 5.652 req/s | **166,2 s** | > 60 s |

Ao final havia **12.169 eventos pendentes**. A causa estava no publisher: cada réplica publicava no máximo 50 eventos a cada 500 ms, enviando lotes de 10 um depois do outro, com um `UPDATE` por evento e pausa mesmo com fila. Isso dava ~300 eventos/s nas 3 réplicas, contra ~3.000 eventos/s produzidos. Nenhum evento se perdia (eles continuavam na outbox), mas o atraso crescia sem limite.

**Correção:**
1. Enquanto o lote vem cheio, o próximo é buscado **sem pausa** (`PollingLoop` com `hasMore`).
2. Os lotes de 10 do SQS são enviados **em paralelo**.
3. **Um único** `UPDATE ... WHERE id = ANY($1)` marca o lote inteiro como publicado.
4. Lote padrão de 200.

**Resultado:** lag máximo de **166 s → 6,7 s**, e a outbox drena em ~5 s depois da carga, em vez de mais de 60 s. As garantias não mudaram: o claim continua com `FOR UPDATE SKIP LOCKED` + lease, e os testes de publishers concorrentes e de publisher morto continuam passando.

### 5.2 `docker compose up` falhava em ambiente zerado

Ao recriar o ambiente com `docker compose down -v` para medir de forma limpa, o container `migrate` falhou com `57P03 the database system is starting up`. No primeiro start, o PostgreSQL sobe um servidor temporário (só via socket) para rodar os scripts de init e depois reinicia. O healthcheck `pg_isready` passava nessa fase temporária.

**Correção:**
- o healthcheck agora testa **por TCP** e consulta o banco de testes;
- o script de migration re-tenta a conexão por até ~30 s se o erro for transitório.

Validado subindo do zero duas vezes seguidas.

## 6. Variância e honestidade sobre os números

Rodei o cenário depois da correção também **sem** recriar o ambiente (`2-` e `3-after-fix-reused-db.json`). Os números variaram muito:

| Execução | distributed | hot-wallet | replay-storm |
|---|---:|---:|---:|
| 2: banco reaproveitado | 1.098 req/s | 178 req/s | 5.234 req/s |
| 3: banco reaproveitado (mais dados acumulados) | 621 req/s | 73 req/s | 1.982 req/s |
| 4: **ambiente zerado** | **1.402 req/s** | **231 req/s** | **6.528 req/s** |

Até o `replay-storm`, que quase não escreve, caiu para menos de 1/3 na execução 3. Por isso atribuo a variação ao **ambiente**, e não ao código: cada execução deixa ~60 mil linhas a mais na outbox e milhares no ledger, há *dead tuples* dos UPDATEs da outbox esperando o autovacuum, e a máquina é um desktop compartilhado. Em todas as execuções a **correção** foi a mesma: 0% de erro e todas as wallets consistentes.

**Recomendações que saíram disso:**
- medir sempre com o ambiente zerado (por isso o comando no topo deste arquivo);
- em produção, adicionar **limpeza/particionamento da outbox** (linhas publicadas não precisam ficar na tabela quente) e monitorar o autovacuum dessa tabela. Isso já estava listado como limitação no ARCHITECTURE.md e agora tem evidência.

## 7. O que este teste não cobre

- **Capacidade real de produção:** tudo na mesma máquina; um ambiente sério separaria gerador, aplicação e banco.
- **Carga aberta (open-loop / RPS fixo):** o modelo fechado mede o throughput máximo, não a latência sob uma taxa de chegada fixa (para isso, k6 com `constant-arrival-rate`).
- **Consumo via SQS sob carga:** o teste exercita a entrada HTTP; a entrada SQS usa o mesmo use case e foi validada em correção (não em throughput) nos testes de integração e multi-instância.
- **Execuções longas (soak):** 20 s por cenário não revelam vazamento de memória nem crescimento de tabela ao longo de horas.
