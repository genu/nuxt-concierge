import { defineEventHandler } from "h3";
import { $useConcierge } from "#concierge";

export default defineEventHandler(async () => {
  const { getQueue } = $useConcierge();
  const q = getQueue("myQueue");

  await q.add("myJob", { foo: "bar" });
});
