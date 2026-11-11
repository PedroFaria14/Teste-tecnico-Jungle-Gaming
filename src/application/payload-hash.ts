import { createHash } from 'node:crypto';

/**
 * JSON canônico: chaves ordenadas recursivamente, sem espaços, campos `undefined` omitidos.
 * Dois payloads com os mesmos dados em ordens diferentes geram exatamente a mesma string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface WagerBusinessFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/**
 * payloadHash = SHA-256 (hex) do JSON canônico APENAS dos campos de negócio.
 * O header Idempotency-Key, correlationId, messageId e qualquer metadado de transporte ficam de fora.
 * O amount entra já normalizado (ex.: "25.5" → "25.50") para que a mesma quantia gere o mesmo hash.
 */
export function wagerPayloadHash(fields: WagerBusinessFields): string {
  return sha256Hex(
    canonicalJson({
      providerId: fields.providerId,
      externalTransactionId: fields.externalTransactionId,
      playerId: fields.playerId,
      walletId: fields.walletId,
      roundId: fields.roundId,
      gameId: fields.gameId,
      kind: fields.kind,
      money: { amount: fields.money.amount, currency: fields.money.currency },
      referenceExternalTransactionId: fields.referenceExternalTransactionId,
    }),
  );
}
