import { Queue, Worker } from "bullmq";
import { useLogger } from "@nuxt/kit";

import type {
  WorkerOptions,
  ConnectionOptions,
  QueueOptions,
  RedisOptions,
  Processor,
} from "bullmq";
import { useRuntimeConfig } from "#imports";

const logger = useLogger("nuxt-concierge");

const queues: Queue[] = [];
const workers: Worker[] = [];

export const $concierge = () => {
  const {
    concierge: {
      redis: { host, password, port },
    },
  } = useRuntimeConfig();

  const redisOptions: RedisOptions = {
    host,
    password,
    port,
    retryStrategy: function (times: number) {
      return Math.max(Math.min(Math.exp(times), 20000), 1000);
    },
  };

  const createQueue = (
    name: string,
    opts?: Omit<QueueOptions, "connection">
  ) => {
    // check if queue already exists
    if (queues.find((queue) => queue.name === name)) {
      logger.warn(`Queue ${name} already exists`);
      return;
    }
    const defaultConnectionOptions: ConnectionOptions = {
      enableOfflineQueue: false,
    };

    queues.push(
      new Queue(name, {
        connection: { ...redisOptions, ...defaultConnectionOptions },
        ...opts,
      })
    );
  };

  const createWorker = (
    name: string,
    processor?: string | URL | null | Processor,
    opts?: Omit<WorkerOptions, "connection">
  ) => {
    const defaultConnectionOptions: ConnectionOptions = {
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    };

    workers.push(
      new Worker(name, processor, {
        connection: { ...redisOptions, ...defaultConnectionOptions },
        ...opts,
      }).on("closed", () => {
        logger.info(`Worker ${name} stopped`);
      })
    );
  };

  /**
   * Returns the a queue by name. If queue is not found, it will return undefined but log a warning.
   *
   * @param name Name of the queue
   */
  const getQueue = (name: string) => {
    const queue = queues.find((queue) => queue.name === name)!;

    if (!queue) {
      logger.warn(`Queue ${name} not found`);
    }

    return queue;
  };

  return {
    queues,
    workers,
    createQueue,
    createWorker,
    getQueue,
  };
};
