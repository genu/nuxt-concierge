import { defineCron } from "#imports";

export default defineCron(
  "PingServer",
  async () => {
    console.log("Ping!");
    return "Pong";
  },
  {
    every: 5000, // 5 seconds
  }
);
