import type { Job, RepeatOptions } from "bullmq";

export const defineCron = (
  name: string,
  processor: (job: Job) => Promise<unknown>,
  schedule: RepeatOptions
) => {
  return {
    name,
    processor,
    schedule,
  };
};
