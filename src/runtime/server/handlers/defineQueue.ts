import type { QueueOptions } from "bullmq";

export const defineQueue = (
  name: string,
  opts?: Omit<QueueOptions, "connection">
) => {
  return {
    name,
    opts,
  };
};
