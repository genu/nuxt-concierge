import { defineQueue } from "#imports";

export default defineQueue("SendEmail", {
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: true,
  },
});
