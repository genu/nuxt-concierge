import { defineCron } from "#concierge-handlers";

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
