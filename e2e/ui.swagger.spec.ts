import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

/** Documentação interativa: carrega, lista os endpoints e executa uma chamada real pelo "Try it out". */

test('Swagger UI lista todos os endpoints do desafio', async ({ page }) => {
  await page.goto('/docs');
  await expect(page.getByRole('heading', { name: /Jungle Gaming — Wagering Service/ })).toBeVisible();
  for (const path of [
    '/wallets',
    '/wallets/{walletId}',
    '/wallets/{walletId}/ledger',
    '/wallets/{walletId}/reconciliation',
    '/wagering/transactions',
    '/wagering/transactions/{transactionId}',
    '/providers/{providerId}/wagering/transactions/{externalTransactionId}',
    '/health/live',
    '/health/ready',
    '/metrics',
  ]) {
    await expect(page.locator(`[data-path="${path}"]`).first(), path).toBeVisible();
  }
});

test('"Try it out" cria uma wallet de verdade pela interface', async ({ page }) => {
  await page.goto('/docs');
  const op = page.locator('#operations-Wallets-post_wallets');
  await op.locator('.opblock-summary').click();
  await op.getByRole('button', { name: 'Try it out' }).click();
  const body = JSON.stringify({ playerId: randomUUID(), initialBalance: { amount: '42.00', currency: 'BRL' } });
  await op.locator('textarea.body-param__text').fill(body);
  await op.getByRole('button', { name: 'Execute' }).click();
  const live = op.locator('.live-responses-table');
  await expect(live.locator('tbody .response-col_status').first()).toHaveText('201');
  await expect(live.locator('.microlight').first()).toContainText('"42.00"');
});
