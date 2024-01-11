export default defineWorker(
  "UserQueueFactory",
  async (job) => {
    console.log("user factory job");
  },
  {}
);
