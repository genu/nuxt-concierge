import { defineQueue } from "#concierge-handlers";

export default defineQueue("SendEmail", {
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: true,
  },
});
