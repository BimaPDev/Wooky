import type { AppearanceTheme, ThemeBackground } from "@age/contracts";
import { useEffect, useRef, useState } from "react";
import {
  getTheme,
  previewThemeLocally,
  restoreSavedTheme,
  saveTheme,
} from "../../state/appearance.ts";
import { useStore } from "../../state/store.ts";
import { Slider } from "../ThemeEditor.tsx";
import {
  applyWallpaperPatch,
  effectiveColorMode,
  forkAsYours,
  previewTheme,
  wallpaperFileToDataUrl,
  wallpaperWriteTarget,
} from "./helpers.ts";
import { activateListedTheme } from "./rpc.ts";
import { invalidateThemeThumbnail } from "./thumbnails.ts";

export function WallpaperControls({
  themeId,
  busy,
  onBusy,
  onError,
  onCatalogChanged,
}: {
  themeId: string;
  busy: boolean;
  onBusy: (value: boolean) => void;
  onError: (message: string | null) => void;
  onCatalogChanged: () => Promise<void>;
}) {
  const colorMode = useStore((state) => state.deviceSettings?.colorMode ?? "system");
  const mode = effectiveColorMode(colorMode);
  const [theme, setTheme] = useState<AppearanceTheme | null>(null);
  const [draftBg, setDraftBg] = useState<ThemeBackground>({});
  const input = useRef<HTMLInputElement>(null);
  const activeIdRef = useRef(themeId);
  const mountedRef = useRef(true);
  const draftThemeRef = useRef<AppearanceTheme | null>(null);
  const debounceRef = useRef(0);
  const pendingRef = useRef<AppearanceTheme | null>(null);
  const savingRef = useRef(false);

  // sync: drop in-flight wallpaper saves after the loaded theme changes
  useEffect(() => {
    activeIdRef.current = themeId;
  }, [themeId]);

  // sync: load the active theme so wallpaper sliders can edit it
  useEffect(() => {
    let cancelled = false;
    void getTheme(themeId).then(
      (loaded) => {
        if (cancelled) return;
        draftThemeRef.current = loaded;
        setTheme(loaded);
        setDraftBg(layerFor(loaded, mode));
      },
      (err: unknown) => {
        if (!cancelled)
          onError(err instanceof Error ? err.message : "Could not load wallpaper settings.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [themeId, mode, onError]);

  // sync: restore the saved appearance after a live wallpaper preview
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      restoreSavedTheme();
    };
  }, []);

  if (!theme || !layerFor(theme, mode).image) return null;
  const bg = draftBg;

  const preview = (nextBg: ThemeBackground) => {
    const base = draftThemeRef.current ?? theme;
    previewThemeLocally(previewTheme(applyWallpaperPatch(base, mode, nextBg), mode));
  };

  const queueSave = (nextTheme: AppearanceTheme) => {
    const draft = nextTheme.builtin ? forkAsYours(nextTheme) : nextTheme;
    draftThemeRef.current = draft;
    pendingRef.current = draft;
    void flushSaves();
  };

  const flushSaves = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    const startedId = themeId;
    try {
      while (pendingRef.current) {
        const next = pendingRef.current;
        pendingRef.current = null;
        const saved = await saveTheme(next);
        invalidateThemeThumbnail(startedId);
        invalidateThemeThumbnail(saved.id);
        await onCatalogChanged();
        if (isStaleSave(mountedRef.current, activeIdRef.current, startedId, saved.id)) return;
        if (next.id !== startedId || saved.id !== startedId)
          await activateListedTheme(saved.id, saved.appearance);
        if (isStaleSave(mountedRef.current, activeIdRef.current, startedId, saved.id)) return;
        setTheme(saved);
        draftThemeRef.current = saved;
        if (debounceRef.current === 0 && !pendingRef.current) {
          setDraftBg(layerFor(saved, mode));
          restoreSavedTheme();
        }
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not update wallpaper.");
    } finally {
      savingRef.current = false;
      if (
        pendingRef.current &&
        !isStaleSave(mountedRef.current, activeIdRef.current, startedId, startedId)
      )
        void flushSaves();
    }
  };

  const persistDraft = (nextBg: ThemeBackground) => {
    onError(null);
    const base = draftThemeRef.current ?? theme;
    queueSave(applyWallpaperPatch(base, mode, nextBg));
  };

  const schedulePersist = (nextBg: ThemeBackground) => {
    setDraftBg(nextBg);
    preview(nextBg);
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = 0;
      persistDraft(nextBg);
    }, 250);
  };

  const commit = (nextBg: ThemeBackground) => {
    setDraftBg(nextBg);
    preview(nextBg);
    window.clearTimeout(debounceRef.current);
    debounceRef.current = 0;
    persistDraft(nextBg);
  };

  const pick = async (file: File) => {
    onError(null);
    onBusy(true);
    try {
      const wallpaper = await wallpaperFileToDataUrl(file);
      const nextBg = { ...bg, ...wallpaper };
      setDraftBg(nextBg);
      preview(nextBg);
      window.clearTimeout(debounceRef.current);
      debounceRef.current = 0;
      persistDraft(nextBg);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not read that image.");
    } finally {
      onBusy(false);
    }
  };

  return (
    <section className="appearance-section">
      <h3>Wallpaper</h3>
      <div className="settings-card appearance-interface">
        <div className="setting-row">
          <div className="setting-copy">
            <p className="setting-title">Use my own wallpaper</p>
            <p className="setting-desc">SVG, PNG, JPG or WebP. Built-in themes save as a copy.</p>
          </div>
          <div className="setting-control">
            <button
              type="button"
              className="ghost-button"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              Choose file
            </button>
            <input
              ref={input}
              type="file"
              accept="image/svg+xml,.svg,image/png,.png,image/jpeg,.jpg,.jpeg,image/webp,.webp"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void pick(file);
              }}
            />
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <p className="setting-title">Fit</p>
            <p className="setting-desc">How the image fills the window.</p>
          </div>
          <div className="setting-control">
            <div className="segmented" role="group" aria-label="Fit">
              {(
                [
                  ["cover", "Fill"],
                  ["contain", "Fit"],
                  ["tile", "Tile"],
                ] as const
              ).map(([value, label]) => {
                const current = bg.fit ?? "cover";
                return (
                  <button
                    key={value}
                    type="button"
                    className={current === value ? "segmented-item active" : "segmented-item"}
                    aria-pressed={current === value}
                    disabled={busy}
                    onClick={() => commit({ ...bg, fit: value === "cover" ? undefined : value })}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <WallpaperSlider
          title="Dim"
          description="Canvas-coloured veil over the image, for legibility."
          value={bg.dim ?? 35}
          min={0}
          max={90}
          step={5}
          format={(n) => `${n}%`}
          onDraft={(dim) => schedulePersist({ ...bg, dim })}
          onCommit={(dim) => commit({ ...bg, dim })}
        />
        <WallpaperSlider
          title="Blur"
          description="Soften the image behind the interface."
          value={bg.blur ?? 0}
          min={0}
          max={40}
          step={1}
          format={(n) => `${n}px`}
          onDraft={(blur) => schedulePersist({ ...bg, blur: blur || undefined })}
          onCommit={(blur) => commit({ ...bg, blur: blur || undefined })}
        />
        <WallpaperSlider
          title="Panel blur"
          description="Frosted glass on app panels over the wallpaper."
          value={bg.panelBlur ?? 0}
          min={0}
          max={40}
          step={1}
          format={(n) => `${n}px`}
          onDraft={(panelBlur) => schedulePersist({ ...bg, panelBlur: panelBlur || undefined })}
          onCommit={(panelBlur) => commit({ ...bg, panelBlur: panelBlur || undefined })}
        />
        <WallpaperSlider
          title="Surface opacity"
          description="How solid app surfaces are over the image."
          value={bg.surfaceOpacity ?? 82}
          min={0}
          max={100}
          step={2}
          format={(n) => `${n}%`}
          onDraft={(surfaceOpacity) => schedulePersist({ ...bg, surfaceOpacity })}
          onCommit={(surfaceOpacity) => commit({ ...bg, surfaceOpacity })}
        />
      </div>
    </section>
  );
}

function isStaleSave(
  mounted: boolean,
  currentId: string,
  startedId: string,
  savedId: string,
): boolean {
  if (!mounted) return true;
  return currentId !== startedId && currentId !== savedId;
}

function layerFor(theme: AppearanceTheme, mode: "dark" | "light"): ThemeBackground {
  if (wallpaperWriteTarget(theme, mode) === "variant") {
    return theme.variants?.[mode]?.background ?? {};
  }
  return theme.background ?? {};
}

function WallpaperSlider({
  title,
  description,
  value,
  min,
  max,
  step,
  format,
  onDraft,
  onCommit,
}: {
  title: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (n: number) => string;
  onDraft: (n: number) => void;
  onCommit: (n: number) => void;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <p className="setting-title">{title}</p>
        <p className="setting-desc">{description}</p>
      </div>
      <div className="setting-control">
        <Slider
          label={title}
          value={value}
          min={min}
          max={max}
          step={step}
          format={format}
          onChange={onDraft}
          onCommit={onCommit}
        />
      </div>
    </div>
  );
}
