function itemIdFromUrl(value) {
  try {
    return new URL(value).pathname.match(/\/video\/(\d+)/)?.[1] || "";
  } catch {
    return "";
  }
}

function positiveNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function httpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function addressUrl(address) {
  if (typeof address === "string") return httpUrl(address);
  const values = address?.UrlList || address?.urlList || [];
  const urls = (Array.isArray(values) ? values : [values]).map(httpUrl).filter(Boolean);
  const direct = urls.find((value) => {
    try {
      return !/(?:^|\.)tiktok\.com$/i.test(new URL(value).hostname);
    } catch {
      return false;
    }
  });
  return direct || urls[0] || "";
}

function variantFromEntry(entry, video) {
  const address = entry?.PlayAddr || entry?.playAddr || {};
  const url = addressUrl(address);
  if (!url) return null;

  return {
    url,
    width: positiveNumber(address.Width || address.width || video.width),
    height: positiveNumber(address.Height || address.height || video.height),
    bitrate: positiveNumber(entry.Bitrate || entry.bitrate),
    size: positiveNumber(address.DataSize || address.dataSize),
    codec: String(entry.CodecType || entry.codecType || "")
  };
}

function fallbackVariant(video) {
  for (const address of [video.playAddr, video.downloadAddr]) {
    const url = addressUrl(address);
    if (!url) continue;
    return {
      url,
      width: positiveNumber(address.Width || address.width || video.width),
      height: positiveNumber(address.Height || address.height || video.height),
      bitrate: positiveNumber(address.Bitrate || address.bitrate),
      size: positiveNumber(address.DataSize || address.dataSize),
      codec: ""
    };
  }
  return null;
}

function compareQuality(left, right) {
  const areaDifference = right.width * right.height - left.width * left.height;
  if (areaDifference) return areaDifference;
  const bitrateDifference = right.bitrate - left.bitrate;
  if (bitrateDifference) return bitrateDifference;
  return right.size - left.size;
}

export function tiktokItemIdFromUrl(value) {
  return itemIdFromUrl(value);
}

export function tiktokMediaFromUniversalData(value, pageUrl) {
  const pageItemId = itemIdFromUrl(pageUrl);
  if (!pageItemId) return null;

  let data = value;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }

  const detail = data?.__DEFAULT_SCOPE__?.["webapp.video-detail"];
  const item = detail?.itemInfo?.itemStruct;
  if (!item || String(item.id || "") !== pageItemId) return null;

  const video = item.video || {};
  const variants = (Array.isArray(video.bitrateInfo) ? video.bitrateInfo : [])
    .map((entry) => variantFromEntry(entry, video))
    .filter(Boolean)
    .sort(compareQuality);
  const selected = variants[0] || fallbackVariant(video);
  if (!selected) return null;

  return {
    url: selected.url,
    mediaKey: `tiktok:${pageItemId}`,
    itemId: pageItemId,
    durationSeconds: positiveNumber(video.duration),
    resolution: selected.width && selected.height ? `${selected.width}x${selected.height}` : "",
    bitrateKbps: selected.bitrate ? Math.round(selected.bitrate / 1000) : 0,
    size: selected.size,
    codec: selected.codec
  };
}
