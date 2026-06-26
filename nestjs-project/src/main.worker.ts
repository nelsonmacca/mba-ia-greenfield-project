import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * Worker entrypoint (TD-04).
 *
 * Boots the same NestJS codebase as an application *context* — no HTTP server is
 * started, so the worker container never binds a port. BullMQ consumers
 * (added in later SIs) run off the DI container created here.
 */
async function bootstrap() {
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();
  logger.log('Video worker started (worker mode, no HTTP listener)');
}
void bootstrap();
