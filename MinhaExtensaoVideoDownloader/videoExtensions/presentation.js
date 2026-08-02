import { detectVideoExtension } from "./detect.js";
import { m3u8Presentation } from "./m3u8/presentation.js";
import { directPresentation } from "./direct/presentation.js";
import { metaMp4Presentation } from "./metaMp4/presentation.js";

const PRESENTATION_BY_VIDEO_EXTENSION = new Map([
  [m3u8Presentation.id, m3u8Presentation],
  [directPresentation.id, directPresentation],
  [metaMp4Presentation.id, metaMp4Presentation]
]);

export function getVideoExtensionPresentation(media) {
  const id = detectVideoExtension(media);
  return id ? PRESENTATION_BY_VIDEO_EXTENSION.get(id) || null : null;
}
