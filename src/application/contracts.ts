import { z } from 'zod';
import { EXTERNAL_KINDS } from '../domain/wager-transaction';

/**
 * Validação estrutural dos contratos de entrada (HTTP e SQS usam o mesmo schema).
 * Regras de dinheiro (escala, negativos, notação científica...) ficam no Money.from —
 * aqui só garantimos que amount/currency são strings.
 */
const id = (max: number) => z.string().trim().min(1).max(max);

export const moneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

export const submitWagerSchema = z
  .object({
    providerId: id(100),
    externalTransactionId: id(200),
    playerId: z.string().uuid(),
    walletId: z.string().uuid(),
    roundId: id(200),
    gameId: id(200),
    kind: z.enum(EXTERNAL_KINDS),
    money: moneySchema,
    referenceExternalTransactionId: id(200).optional(),
  })
  .strict();

export type SubmitWagerBody = z.infer<typeof submitWagerSchema>;

export const createWalletSchema = z
  .object({
    playerId: z.string().uuid(),
    initialBalance: moneySchema,
  })
  .strict();

export type CreateWalletBody = z.infer<typeof createWalletSchema>;

export const idempotencyKeySchema = z.string().trim().min(1).max(255);

export const wagerMessageSchema = z.object({
  messageId: id(200),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().datetime(),
  data: submitWagerSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;
