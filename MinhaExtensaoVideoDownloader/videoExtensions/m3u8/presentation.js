function filename(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "").toLowerCase();
  } catch {
    return "";
  }
}

export const m3u8Presentation = Object.freeze({
  id: "m3u8",
  actionLabel: "",
  downloadTitle: "Baixar HLS",

  score(media) {
    return filename(media.url) === "playlist.m3u8" ? 100 : 90;
  },

  hint(media) {
    return filename(media.url) === "playlist.m3u8"
      ? "Recomendado: playlist principal com as qualidades."
      : "HLS detectado: use este em vez dos segmentos.";
  }
});
