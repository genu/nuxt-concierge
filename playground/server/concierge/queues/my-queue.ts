import { defineQueue } from "#imports";

export default defineQueue("MyQueue", {
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: true,
  },
});
