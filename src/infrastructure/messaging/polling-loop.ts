import { logger } from '../../shared/observability/logger';

/**
 * Loop simples "faz uma rodada, espera, repete". `stop()` espera a rodada em andamento terminar —
 * é isso que garante o graceful shutdown dos workers.
 *
 * `hasMore(resultado)`: se a rodada indicar que ainda há trabalho (ex.: lote veio cheio), a próxima
 * rodada começa imediatamente, sem esperar o intervalo — drena backlog sem pausa.
 */
export class PollingLoop<T = unknown> {
  private running = false;
  private current: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<T>,
    private readonly hasMore: (result: T) => boolean = () => false,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    await this.current;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let more = false;
      try {
        more = this.hasMore(await this.tick());
      } catch (error) {
        logger.error(`${this.name} iteration failed`, { error });
      }
      if (!this.running) break;
      if (more) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.intervalMs);
        this.wakeUp = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}
