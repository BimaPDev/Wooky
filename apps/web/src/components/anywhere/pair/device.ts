const DEVICE_KEY = "wooky.pair.deviceId";

/** Stable id for this browser, created once and kept in localStorage. */
export function pairDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing && existing.length > 0) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function browserDeviceName(ua = navigator.userAgent): string {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Safari\//.test(ua)
        ? "Safari"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : "Browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "this device";
  return `${browser} on ${os}`;
}

export function browserPlatform(ua = navigator.userAgent): "darwin" | "win32" | "linux" | "other" {
  if (/iPhone|iPad|Android/.test(ua)) return "other";
  if (/Mac OS X/.test(ua)) return "darwin";
  if (/Windows/.test(ua)) return "win32";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}
