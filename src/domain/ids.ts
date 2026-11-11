/** UUID v7 (ordenado por tempo) — melhor para índices B-tree do que v4. */
export function newId(): string {
  return Bun.randomUUIDv7();
}
