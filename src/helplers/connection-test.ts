import Redis from "ioredis";
import type { RedisOptions } from "ioredis";

export const isValidRedisConnection = async (
  redisOptions: RedisOptions
): Promise<boolean> => {
  return new Promise<boolean>((resolve) => {
    const client = new Redis({ ...redisOptions, lazyConnect: true });

    client
      .connect()
      .then(() => {
        client.disconnect();
        resolve(true);
      })
      .catch(() => {});

    client.on("error", () => {
      resolve(false);
      client.disconnect();
    });
  });
};
