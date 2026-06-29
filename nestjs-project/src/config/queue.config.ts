import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  // Redis connection for BullMQ. In Docker this is the Compose service name.
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
}));
