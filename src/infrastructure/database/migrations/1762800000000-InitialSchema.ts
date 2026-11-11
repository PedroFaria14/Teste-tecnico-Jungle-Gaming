import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schema inicial. As invariantes do domínio são repetidas aqui como constraints,
 * porque o banco é a última linha de defesa contra bugs e corridas entre instâncias:
 *
 * - saldo nunca negativo .............. CHECK (balance >= 0)
 * - 1 wallet por player+moeda ......... UNIQUE (player_id, currency)
 * - idempotência persistente .......... UNIQUE (idempotency_key) e UNIQUE (provider_id, external_transaction_id)
 * - 1 lançamento por wallet/transação . UNIQUE (wallet_id, transaction_id)
 * - lançamento fecha a conta .......... CHECK balance_after = balance_before ± amount
 * - ledger imutável ................... trigger bloqueia UPDATE/DELETE
 * - transação terminal imutável ....... trigger bloqueia UPDATE em PROCESSED/REJECTED/FAILED
 * - referência revertida 1 vez ........ UNIQUE parcial (reference_transaction_id) para REFUND/ROLLBACK processados
 * - inbox ............................. PK (consumer_name, message_id)
 */
export class InitialSchema1762800000000 implements MigrationInterface {
  name = 'InitialSchema1762800000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   uuid           NOT NULL,
        currency    char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(19, 2) NOT NULL CHECK (balance >= 0),
        version     integer        NOT NULL CHECK (version >= 1),
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
      )`);

    await q.query(`
      CREATE TABLE wager_transactions (
        id                                 uuid           PRIMARY KEY,
        provider_id                        varchar(100)   NOT NULL,
        external_transaction_id            varchar(200)   NOT NULL,
        idempotency_key                    varchar(255)   NOT NULL,
        payload_hash                       varchar(64)    NOT NULL,
        wallet_id                          uuid           NOT NULL REFERENCES wallets (id),
        player_id                          uuid           NOT NULL,
        round_id                           varchar(200)   NOT NULL,
        game_id                            varchar(200)   NOT NULL,
        kind                               varchar(16)    NOT NULL
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                             numeric(19, 2) NOT NULL CHECK (amount >= 0),
        currency                           char(3)        NOT NULL,
        reference_external_transaction_id  varchar(200),
        reference_transaction_id           uuid           REFERENCES wager_transactions (id),
        status                             varchar(20)    NOT NULL
          CHECK (status IN ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                       varchar(64),
        result_balance                     numeric(19, 2),
        reference_attempts                 integer        NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_attempt_at                    timestamptz,
        correlation_id                     varchar(200)   NOT NULL,
        created_at                         timestamptz    NOT NULL,
        processed_at                       timestamptz,
        updated_at                         timestamptz    NOT NULL,
        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT ck_wager_tx_reference_required
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_wager_tx_failure_code
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_wager_tx_pending_schedule
          CHECK (status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL)
      )`);

    // Uma transação referenciada só pode ser revertida uma vez (REFUND ou ROLLBACK processado).
    await q.query(`
      CREATE UNIQUE INDEX uq_wager_tx_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')`);
    // Busca do worker de PENDING_REFERENCE.
    await q.query(`
      CREATE INDEX ix_wager_tx_pending_reference
        ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);
    await q.query(`CREATE INDEX ix_wager_tx_wallet ON wager_transactions (wallet_id)`);

    await q.query(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        seq             bigserial      NOT NULL UNIQUE,
        wallet_id       uuid           NOT NULL REFERENCES wallets (id),
        transaction_id  uuid           NOT NULL REFERENCES wager_transactions (id),
        direction       varchar(6)     NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount          numeric(19, 2) NOT NULL CHECK (amount > 0),
        currency        char(3)        NOT NULL,
        balance_before  numeric(19, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(19, 2) NOT NULL CHECK (balance_after >= 0),
        created_at      timestamptz    NOT NULL,
        CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      )`);
    await q.query(`CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq)`);

    await q.query(`
      CREATE TABLE inbox_messages (
        consumer_name  varchar(100) NOT NULL,
        message_id     varchar(200) NOT NULL,
        payload_hash   varchar(64)  NOT NULL,
        received_at    timestamptz  NOT NULL,
        processed_at   timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    await q.query(`
      CREATE TABLE outbox_messages (
        id               uuid         PRIMARY KEY,
        aggregate_id     uuid         NOT NULL,
        event_type       varchar(100) NOT NULL,
        payload          jsonb        NOT NULL,
        occurred_at      timestamptz  NOT NULL,
        attempts         integer      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at  timestamptz  NOT NULL,
        published_at     timestamptz,
        last_error       text
      )`);
    await q.query(`
      CREATE INDEX ix_outbox_pending
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL`);

    // ---- imutabilidade garantida pelo banco ----------------------------------------------
    await q.query(`
      CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% is not allowed)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE TRIGGER trg_ledger_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation()`);

    await q.query(`
      CREATE FUNCTION forbid_terminal_transaction_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%) and cannot be changed', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE TRIGGER trg_wager_tx_terminal_immutable
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_terminal_transaction_mutation()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS outbox_messages`);
    await q.query(`DROP TABLE IF EXISTS inbox_messages`);
    await q.query(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    await q.query(`DROP TABLE IF EXISTS wager_transactions`);
    await q.query(`DROP TABLE IF EXISTS wallets`);
    await q.query(`DROP FUNCTION IF EXISTS forbid_terminal_transaction_mutation()`);
    await q.query(`DROP FUNCTION IF EXISTS forbid_ledger_mutation()`);
  }
}
