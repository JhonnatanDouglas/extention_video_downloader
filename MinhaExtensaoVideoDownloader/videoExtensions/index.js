import { createM3u8Handler } from "./m3u8/index.js";
import { createDirectHandler } from "./direct/index.js";
import { createMetaMp4Handler } from "./metaMp4/index.js";
import { detectVideoExtension } from "./detect.js";

export function createVideoExtensionRouter(dependencies) {
  const handlers = new Map([
    ["m3u8", createM3u8Handler(dependencies)],
    ["direct", createDirectHandler(dependencies)],
    ["meta-mp4", createMetaMp4Handler(dependencies)]
  ]);

  return Object.freeze({
    resolve(media) {
      const id = detectVideoExtension(media);
      return { id, handler: id ? handlers.get(id) || null : null };
    },

    async cleanupTab(tabId) {
      await Promise.all([...handlers.values()].map((handler) => handler.cleanupTab?.(tabId)));
    }
  });
}
