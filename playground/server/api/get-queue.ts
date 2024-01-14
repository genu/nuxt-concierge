import { defineEventHandler } from "h3";
import { $concierge } from "#concierge";

export default defineEventHandler(async () => {
  const { getQueue } = $concierge();
  const q = getQueue("myQueue");

  await q.add("myJob", { foo: "bar" });
});
