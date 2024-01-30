import { defineQueue } from "#concierge";

export default defineQueue("SendEmail", {
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: true,
  },
});
