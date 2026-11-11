/**
 * Taxonomia de falhas. O código é estável e pensado para o provedor decidir o que fazer:
 *
 * | código                       | o provedor deve...                                   |
 * |------------------------------|------------------------------------------------------|
 * | INSUFFICIENT_FUNDS           | desistir (aposta sem saldo)                          |
 * | REVERSAL_INSUFFICIENT_FUNDS  | escalar para operação manual (reversão sem saldo)    |
 * | CURRENCY_MISMATCH            | corrigir o payload                                   |
 * | PLAYER_WALLET_MISMATCH       | corrigir o payload                                   |
 * | REFERENCE_NOT_FOUND          | reenviar a referência e depois a operação, com nova key |
 * | REFERENCE_MISMATCH           | corrigir o payload (rodada/player/wallet/moeda)      |
 * | REFERENCE_KIND_NOT_ALLOWED   | corrigir o payload (ex.: REFUND de um WIN)           |
 * | REFERENCE_NOT_PROCESSED      | desistir (referência foi rejeitada)                  |
 * | REFERENCE_ALREADY_REVERSED   | desistir (já foi revertida)                          |
 * | AMOUNT_MISMATCH              | corrigir o payload (reversão parcial não suportada)  |
 * | PROCESSING_FAILED            | (FAILED) erro permanente interno — abrir incidente   |
 */
export const FailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  PlayerWalletMismatch: 'PLAYER_WALLET_MISMATCH',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  ReferenceKindNotAllowed: 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed: 'REFERENCE_ALREADY_REVERSED',
  AmountMismatch: 'AMOUNT_MISMATCH',
  ProcessingFailed: 'PROCESSING_FAILED',
} as const;
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];
