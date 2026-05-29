import Redis from 'ioredis';

declare const process: {
  env: Record<string, string | undefined>;
};

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) {
          console.error('Redis connection failed after multiple retries');
          return null; // Stop retrying
        }
        return Math.min(times * 200, 2000); // Exponential backoff
      },
    });

    redisClient.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    redisClient.on('connect', () => {
      console.log('Redis client connected successfully');
    });
  }

  return redisClient;
}

export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    console.log('Redis client connection closed');
  }
}

// Distributed lock utility
export async function acquireDistributedLock(
  lockKey: string,
  ttlSeconds: number = 55
): Promise<boolean> {
  const client = getRedisClient();
  
  try {
    // SET key value NX EX seconds - Set if Not eXists with EXpiration
    const result = await client.set(lockKey, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (error) {
    console.error(`Failed to acquire distributed lock ${lockKey}:`, error);
    return false;
  }
}

export async function releaseDistributedLock(lockKey: string): Promise<void> {
  const client = getRedisClient();
  
  try {
    await client.del(lockKey);
  } catch (error) {
    console.error(`Failed to release distributed lock ${lockKey}:`, error);
  }
}
