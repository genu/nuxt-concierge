import type { Job, RepeatOptions } from "bullmq";

export const defineCron = (
  name: string,
  processor: (job: Job) => Promise<any>,
  schedule: RepeatOptions
) => {
  return {
    name,
    processor,
    schedule,
  };
};
