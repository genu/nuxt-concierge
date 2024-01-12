import type { Processor, WorkerOptions } from "bullmq";

export const defineWorker = (
  name: string,
  processor?: string | URL | null | Processor,
  opts?: Omit<WorkerOptions, "connection">
) => {
  return {
    name,
    processor,
    opts,
  };
};
