import { InvalidTransactionStateError } from './errors';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  at: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

/**
 * Registro de mensagem consumida. A chave (consumerName, messageId) é PK no banco,
 * e o registro é gravado na MESMA transação SQL do efeito financeiro: se a transação
 * fez commit, a mensagem está processada; se não fez, nada aconteceu.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.at);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidTransactionStateError(`inbox message ${this.messageId} already processed`);
    }
    this._processedAt = at;
  }
}
