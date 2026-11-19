import { useEffect, useState } from "react";
import { resolveThemeVariant, stillSvgDataUrl } from "../state/appearance.ts";
import { useStore, type Theme } from "../state/store.ts";

export function Wallpaper({ mode }: { mode: Theme }) {
  const theme = useStore((state) => state.previewAppearance ?? state.activeAppearance);
  const wallpaperMotion = useStore((state) => state.deviceSettings?.wallpaperMotion ?? "on");

  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  const [visible, setVisible] = useState(() =>
    typeof document !== "undefined" ? document.visibilityState === "visible" : true,
  );

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

  const resolved = theme && theme.id !== "default" ? resolveThemeVariant(theme, mode) : null;
  const bg = resolved?.background;
  const image = bg?.image;
  const hasWallpaper = Boolean(image);

  // sync: root data-wallpaper attribute marks when a wallpaper layer is active
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (hasWallpaper) document.documentElement.dataset.wallpaper = "";
    else delete document.documentElement.dataset.wallpaper;
    return () => {
      delete document.documentElement.dataset.wallpaper;
    };
  }, [hasWallpaper]);

  if (!bg || !image) return null;

  const allowMotion = wallpaperMotion === "on" && !reducedMotion && visible;
  const src = allowMotion ? image : stillSvgDataUrl(image);
  const fit = bg.fit ?? "cover";
  const blur = bg.blur ?? 0;
  const dim = bg.dim ?? 35;
  const filter = blur > 0 ? `blur(${blur}px)` : undefined;

  return (
    <div className="wallpaper" data-wallpaper="" aria-hidden="true">
      {fit === "tile" ? (
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
      )}
      {dim > 0 ? <div className="wallpaper-veil" style={{ opacity: dim / 100 }} /> : null}
    </div>
  );
}
