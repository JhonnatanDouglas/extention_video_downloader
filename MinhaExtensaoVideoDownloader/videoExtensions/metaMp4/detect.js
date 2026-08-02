function decodeEfg(value) {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function isMetaCdn(hostname) {
  return /(?:^|\.)(?:fbcdn\.net|cdninstagram\.com)$/i.test(hostname);
}

export function normalizeMetaMediaUrl(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete("bytestart");
    url.searchParams.delete("byteend");
    return url.href;
  } catch {
    return value;
  }
}

export function parseMetaMp4Track(value) {
  try {
    const url = new URL(value);
    if (!isMetaCdn(url.hostname) || !/\.mp4$/i.test(url.pathname)) return null;

    const metadata = decodeEfg(url.searchParams.get("efg"));
    if (!metadata) return null;

    const assetId = String(metadata.xpv_asset_id || metadata.asset_id || "");
    const encodeTag = String(metadata.vencode_tag || metadata.encode_tag || "");
    if (!assetId || !encodeTag) return null;

    const audio = /(?:^|[._-])(?:audio|aac|heaac)(?:[._-]|$)/i.test(encodeTag);
    const resolutionMatch = encodeTag.match(/(?:^|[._-])(\d{3,4})p(?:[._-]|$)/i);
    return {
      assetId,
      kind: audio ? "audio" : "video",
      url: normalizeMetaMediaUrl(url.href),
      originalUrl: url.href,
      encodeTag,
      durationSeconds: Number(metadata.duration_s || metadata.duration || 0),
      bitrate: Number(metadata.bitrate || 0),
      resolution: resolutionMatch ? `${resolutionMatch[1]}p` : ""
    };
  } catch {
    return null;
  }
}
