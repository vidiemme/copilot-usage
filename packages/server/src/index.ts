import './env.js';
import { loadConfig } from './config.js';
import { buildApp } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  await app.server.listen({ port: config.port, host: config.host });

  const shutdown = (signal: string): void => {
    app.server.log.info({ signal }, 'arresto in corso');
    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.server.log.error({ err: error }, 'arresto fallito');
        process.exit(1);
      },
    );
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('Avvio fallito:', error);
  process.exit(1);
});
