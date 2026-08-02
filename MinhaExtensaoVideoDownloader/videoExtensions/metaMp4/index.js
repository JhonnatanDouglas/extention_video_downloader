import { createNativeMediaHandler } from "../nativeMediaHandler.js";

export function createMetaMp4Handler(dependencies) {
  return createNativeMediaHandler(dependencies, {
    id: "meta-mp4",
    action: "download-media-pair",
    createPayload(job) {
      if (!job.audioUrl) throw new Error("A faixa de audio deste video nao foi encontrada.");
      return { videoUrl: job.mediaUrl, audioUrl: job.audioUrl };
    }
  });
}
