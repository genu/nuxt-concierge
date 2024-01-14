export default defineQueue("UserQueueFactory", {
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: true,
  },
});
