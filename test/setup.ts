// Executado antes de qualquer teste (bunfig.toml): silencia logs de info durante os testes.
process.env.LOG_LEVEL ??= 'error';
