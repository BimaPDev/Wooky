import type { AppearanceTheme, ThemeBackground } from "@age/contracts";
import { useEffect, useRef, useState } from "react";
import { getTheme, saveTheme } from "../../state/appearance.ts";
import { Slider } from "../ThemeEditor.tsx";
import { forkAsYours, wallpaperFileToDataUrl, wallpaperOf } from "./helpers.ts";
import { activateListedTheme } from "./rpc.ts";

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
  const [theme, setTheme] = useState<AppearanceTheme | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // sync: load the active theme so wallpaper sliders can edit it
  useEffect(() => {
    let cancelled = false;
    void getTheme(themeId).then(
      (loaded) => {
        if (!cancelled) setTheme(loaded);
      },
      (err: unknown) => {
        if (!cancelled)
          onError(err instanceof Error ? err.message : "Could not load wallpaper settings.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [themeId, onError]);

  if (!theme || !wallpaperOf(theme).image) return null;
  const bg = wallpaperOf(theme);

  const persist = async (next: Partial<ThemeBackground>) => {
    onBusy(true);
    onError(null);
    try {
      const layer = { ...bg, ...next };
      const background = Object.fromEntries(
        Object.entries(layer).filter(([, value]) => value !== undefined),
      ) as ThemeBackground;
      let draft: AppearanceTheme = { ...theme, background };
      if (draft.builtin) draft = forkAsYours(draft);
      const saved = await saveTheme(draft);
      if (theme.builtin || saved.id !== theme.id)
        await activateListedTheme(saved.id, saved.appearance);
      setTheme(saved);
      await onCatalogChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not update wallpaper.");
    } finally {
      onBusy(false);
    }
  };

  const pick = async (file: File) => {
    onError(null);
    try {
      const wallpaper = await wallpaperFileToDataUrl(file);
      await persist(wallpaper);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not read that image.");
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
                    onClick={() => void persist({ fit: value === "cover" ? undefined : value })}
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
          disabled={busy}
          onChange={(dim) => void persist({ dim })}
        />
        <WallpaperSlider
          title="Blur"
          description="Soften the image behind the interface."
          value={bg.blur ?? 0}
          min={0}
          max={40}
          step={1}
          format={(n) => `${n}px`}
          disabled={busy}
          onChange={(blur) => void persist({ blur: blur || undefined })}
        />
        <WallpaperSlider
          title="Panel blur"
          description="Frosted glass on app panels over the wallpaper."
          value={bg.panelBlur ?? 0}
          min={0}
          max={40}
          step={1}
          format={(n) => `${n}px`}
          disabled={busy}
          onChange={(panelBlur) => void persist({ panelBlur: panelBlur || undefined })}
        />
        <WallpaperSlider
          title="Surface opacity"
          description="How solid app surfaces are over the image."
          value={bg.surfaceOpacity ?? 82}
          min={0}
          max={100}
          step={2}
          format={(n) => `${n}%`}
          disabled={busy}
          onChange={(surfaceOpacity) => void persist({ surfaceOpacity })}
        />
      </div>
    </section>
  );
}

function WallpaperSlider({
  title,
  description,
  value,
  min,
  max,
  step,
  format,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (n: number) => string;
  disabled: boolean;
  onChange: (n: number) => void;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <p className="setting-title">{title}</p>
        <p className="setting-desc">{description}</p>
      </div>
      <div className="setting-control">
        <fieldset disabled={disabled} className="theme-wallpaper-slider">
          <Slider
            label={title}
            value={value}
            min={min}
            max={max}
            step={step}
            format={format}
            onChange={onChange}
          />
        </fieldset>
      </div>
    </div>
  );
}
