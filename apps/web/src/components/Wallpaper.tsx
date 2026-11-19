import { memo, useEffect, useState } from "react";
import {
  resolveThemeVariant,
  stillImageCache,
  stillRasterDataUrl,
  stillSvgDataUrl,
} from "../state/appearance.ts";
import { useStore, type Theme } from "../state/store.ts";

function isSvgDataUrl(url: string): boolean {
  return url.startsWith("data:image/svg+xml");
}

function systemColorMode(): Theme {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export const Wallpaper = memo(function Wallpaper() {
  const appearance = useStore((state) => state.previewAppearance ?? state.activeAppearance);
  const wallpaperMotion = useStore((state) => state.deviceSettings?.wallpaperMotion ?? "on");
  const forcedMode = useStore((state) => state.previewAppearance?.appearance ?? state.theme);

  const [systemMode, setSystemMode] = useState<Theme>(systemColorMode);
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  const [visible, setVisible] = useState(() =>
    typeof document !== "undefined" ? document.visibilityState === "visible" : true,
  );
  const [rasterStill, setRasterStill] = useState<string | null>(null);

  const mode: Theme = forcedMode ?? systemMode;

  // sync: OS prefers-color-scheme so variant resolution tracks system mode
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (event: MediaQueryListEvent) =>
      setSystemMode(event.matches ? "light" : "dark");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // sync: OS prefers-reduced-motion media query pauses animated wallpapers
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // sync: document visibility pauses animated wallpapers while the window is hidden
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const resolved =
    appearance && appearance.id !== "default" ? resolveThemeVariant(appearance, mode) : null;
  const bg = resolved?.background;
  const image = bg?.image;
  const hasWallpaper = Boolean(image);
  const allowMotion = wallpaperMotion === "on" && !reducedMotion && visible;
  const isSvg = Boolean(image && isSvgDataUrl(image));

  // sync: root data-wallpaper attribute marks when a wallpaper layer is active
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (hasWallpaper) document.documentElement.dataset.wallpaper = "";
    else delete document.documentElement.dataset.wallpaper;
    return () => {
      delete document.documentElement.dataset.wallpaper;
    };
  }, [hasWallpaper]);

  // sync: freeze animated raster wallpapers to a still first frame when motion is disallowed
  useEffect(() => {
    if (allowMotion || !image || isSvg) {
      setRasterStill(null);
      return;
    }
    const cached = stillImageCache.get(image);
    if (cached !== undefined) {
      setRasterStill(cached);
      return;
    }
    let cancelled = false;
    setRasterStill(null);
    void stillRasterDataUrl(image).then((still) => {
      if (!cancelled) setRasterStill(still);
    });
    return () => {
      cancelled = true;
    };
  }, [allowMotion, image, isSvg]);

  if (!bg || !image) return null;

  const src = allowMotion ? image : isSvg ? stillSvgDataUrl(image) : rasterStill;
  const fit = bg.fit ?? "cover";
  const blur = bg.blur ?? 0;
  const dim = bg.dim ?? 35;
  const filter = blur > 0 ? `blur(${blur}px)` : undefined;

  return (
    <div className="wallpaper" data-wallpaper="" aria-hidden="true">
      {src ? (
        fit === "tile" ? (
          <div
            className="wallpaper-tile"
            style={{
              backgroundImage: `url("${src}")`,
              filter,
            }}
          />
        ) : (
          <img
            className="wallpaper-image"
            src={src}
            alt=""
            draggable={false}
            style={{
              objectFit: fit,
              filter,
            }}
          />
        )
      ) : null}
      {dim > 0 ? <div className="wallpaper-veil" style={{ opacity: dim / 100 }} /> : null}
    </div>
  );
});
