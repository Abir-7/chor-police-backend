import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useWebSocketAdapter(new GameIoAdapter(app));

  // Optional: also serve the built web app (frontend `dist`) from this server,
  // so one address/port is the whole game. Used for the offline phone host and
  // single-server deployments. Set PUBLIC_DIR, or drop the build in ./public.
  const publicDir =
    process.env.PUBLIC_DIR ??
    fileURLToPath(new URL('../public', import.meta.url));

  if (existsSync(publicDir)) {
    app.useStaticAssets(publicDir);
    console.log(`Serving web app from ${publicDir}`);
  }

  const port = Number(process.env.PORT ?? 3000);
  // 0.0.0.0 so other devices on the same hotspot / Wi-Fi can reach it.
  await app.listen(port, '0.0.0.0');
  console.log(
    `Server listening on ${process.env.BASE_URL ?? `http://localhost:${port}`} (port ${port})`,
  );
}
await bootstrap();
