import type { RepeatOptions } from "bullmq";

export const defineCron = (
  name: string,
  processor: () => Promise<any>,
  schedule: RepeatOptions
) => {
  return {
    name,
    processor,
    schedule,
  };
};
