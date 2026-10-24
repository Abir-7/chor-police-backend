import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module.js';

// Load .env from the project root (works from both src/ and dist/)
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/**
 * Default socket.io pings every 25s and waits 20s, so a phone that lost signal
 * is only noticed after ~45s. Tighter heartbeats let the room see a dropped
 * player (and pause for them) within ~15s.
 */
class GameIoAdapter extends IoAdapter {
  createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      pingInterval: 8000,
      pingTimeout: 7000,
    } as ServerOptions);
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new GameIoAdapter(app));
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(
    `Server listening on ${process.env.BASE_URL ?? `http://localhost:${port}`} (port ${port})`,
  );
}
await bootstrap();
