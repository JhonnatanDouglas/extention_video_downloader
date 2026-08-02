import { createNativeMediaHandler } from "../nativeMediaHandler.js";

export function createDirectHandler(dependencies) {
  return createNativeMediaHandler(dependencies, {
    id: "direct",
    action: "download-direct-media",
    createPayload(job) {
      return { url: job.mediaUrl };
    }
  });
}
