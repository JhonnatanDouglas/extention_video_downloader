const HANDLER_BY_FILE_EXTENSION = new Map([
  ["m3u8", "m3u8"]
]);

const HANDLER_BY_MEDIA_TYPE = new Map([
  ["hls", "m3u8"]
]);

const MEDIA_TYPE_BY_HANDLER = new Map([
  ["m3u8", "hls"],
  ["direct", "video"],
  ["meta-mp4", "video"]
]);

function fileExtension(url) {
  try {
    const filename = new URL(url).pathname.split("/").pop() || "";
    const separator = filename.lastIndexOf(".");
    return separator >= 0 ? filename.slice(separator + 1).toLowerCase() : "";
  } catch {
    return "";
  }
}

export function detectVideoExtension(media = {}) {
  const extension = fileExtension(media.url || "");
  const byExtension = HANDLER_BY_FILE_EXTENSION.get(extension);
  if (byExtension) return byExtension;

  const mediaType = String(media.mediaType || media.typeHint || media.type || "").toLowerCase();
  const byMediaType = HANDLER_BY_MEDIA_TYPE.get(mediaType);
  if (byMediaType) return byMediaType;

  const contentType = String(media.contentType || "").toLowerCase();
  if (contentType.includes("mpegurl")) return "m3u8";

  const declared = String(media.videoExtension || "").toLowerCase();
  if (declared) return declared;
  return null;
}

export function mediaTypeForVideoExtension(videoExtension) {
  return MEDIA_TYPE_BY_HANDLER.get(String(videoExtension || "").toLowerCase()) || null;
}
