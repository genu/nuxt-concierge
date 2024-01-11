import Redis from "ioredis";
import type { RedisOptions } from "ioredis";

export const isValidRedisConnection = async (
  redisOptions: RedisOptions
): Promise<boolean> => {
  return new Promise<boolean>((resolve) => {
    const client = new Redis(redisOptions);

    client
      .ping()
      .then(() => resolve(true))
      .catch(() => resolve(false));

    client.on("error", () => {
      resolve(false);
    });
  });
};
