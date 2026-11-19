export const THUMBNAIL_LRU_LIMIT = 24;

class ThumbnailLru {
  private entries = new Map<string, string>();

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: string) {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > THUMBNAIL_LRU_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  invalidateTheme(id: string) {
    const prefix = `${id}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }
}

export const thumbnailLru = new ThumbnailLru();

export function imageCacheKey(id: string, image: string): string {
  return `${id}:${image.length}:${image.slice(0, 64)}:${image.slice(-64)}`;
}

export function invalidateThemeThumbnail(id: string) {
  thumbnailLru.invalidateTheme(id);
}

/** Downscale a wallpaper data URL to a still PNG at most 256px wide. */
export async function thumbnailFromImage(image: string): Promise<string> {
  const blob = await (await fetch(image)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, 256 / Math.max(bitmap.width, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create a 2D canvas context.");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}

export async function cachedWallpaperThumb(themeId: string, image: string): Promise<string> {
  const key = imageCacheKey(themeId, image);
  const hit = thumbnailLru.get(key);
  if (hit) return hit;
  const thumb = await thumbnailFromImage(image);
  thumbnailLru.set(key, thumb);
  return thumb;
}
