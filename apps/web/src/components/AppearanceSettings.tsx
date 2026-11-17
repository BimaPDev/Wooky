import {
  AppearanceTheme,
  type AppearanceTheme as Theme,
  type AppearanceThemeSummary,
  type DeviceSettings as DeviceSettingsValue,
} from "@age/contracts";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  activateTheme,
  deleteTheme,
  getTheme,
  listThemes,
  loadDeviceSettings,
  patchDeviceSettings,
  saveTheme,
} from "../state/appearance.ts";
import { useStore } from "../state/store.ts";
import {
  IconCheck,
  IconCopy,
  IconMoon,
  IconPaint,
  IconPlus,
  IconSun,
  IconTrash,
} from "./Icons.tsx";
import { ThemeEditor } from "./ThemeEditor.tsx";

type ColorMode = DeviceSettingsValue["colorMode"];
type PreviewColors = {
  canvas: string;
  sidebar: string;
  surface: string;
  accentSurface: string;
  accent: string;
  messageSurface: string;
  messageAction: string;
};

const DEFAULTS = {
  appearanceContrast: 100,
  glassOpacity: 80,
  chatWidth: "comfortable" as const,
};

export function AppearanceSettings() {
  const settings = useStore((state) => state.deviceSettings);
  const [catalog, setCatalog] = useState<{
    themesDir: string;
    themes: AppearanceThemeSummary[];
  } | null>(null);
  const [editing, setEditing] = useState<Theme | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const listed = await listThemes();
    setCatalog({ themesDir: listed.themesDir, themes: listed.themes });
    await loadDeviceSettings();
  };

  // sync: load theme catalog when Appearance opens
  useEffect(() => {
    let cancelled = false;
    Promise.all([listThemes(), loadDeviceSettings()]).then(
      ([listed]) =>
        !cancelled && setCatalog({ themesDir: listed.themesDir, themes: listed.themes }),
      (err: unknown) =>
        !cancelled && setError(err instanceof Error ? err.message : "Could not load themes."),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const active = settings?.activeThemeId ?? "default";
  const colorMode = settings?.colorMode ?? "system";
  const activeTheme = catalog?.themes.find((theme) => theme.id === active) ?? null;

  const startCreate = async () => {
    setError(null);
    try {
      const seed = await getTheme(active);
      setEditing({
        ...seed,
        id: `theme-${Date.now().toString(36)}`,
        name: seed.builtin ? "My theme" : `${seed.name} copy`,
        builtin: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a theme.");
    }
  };

  const openTheme = async (id: string) => {
    setError(null);
    try {
      setEditing(await getTheme(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open theme.");
    }
  };

  const applyTheme = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const summary = catalog?.themes.find((theme) => theme.id === id);
      await activateTheme(id, summary?.appearance ?? "dark");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply theme.");
    } finally {
      setBusy(false);
    }
  };

  const duplicateTheme = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const source = await getTheme(id);
      setEditing({
        ...source,
        id: `${source.id}-copy`,
        name: `${source.name} copy`,
        builtin: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not duplicate theme.");
    } finally {
      setBusy(false);
    }
  };

  const persist = async (theme: Theme) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await saveTheme(theme);
      setEditing(null);
      await activateTheme(saved.id, saved.appearance);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save theme.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || editing.builtin) return;
    setBusy(true);
    try {
      await deleteTheme(editing.id);
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete theme.");
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const raw = JSON.parse(await file.text());
      const theme = AppearanceTheme.parse({ ...raw, builtin: false });
      const saved = await saveTheme(theme);
      await activateTheme(saved.id, saved.appearance);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import theme.");
    } finally {
      setBusy(false);
    }
  };

  const contrast = settings?.appearanceContrast ?? DEFAULTS.appearanceContrast;
  const glass = settings?.glassOpacity ?? DEFAULTS.glassOpacity;
  const chatWidth = settings?.chatWidth ?? DEFAULTS.chatWidth;

  return (
    <div className="appearance-page">
      <section className="appearance-section">
        <h3>Color scheme</h3>
        <div className="appearance-mode-grid" role="group" aria-label="Appearance mode">
          {(["system", "light", "dark"] as const).map((mode) => (
            <ModeTile
              key={mode}
              mode={mode}
              active={colorMode === mode}
              theme={activeTheme}
              onSelect={() => void patchDeviceSettings({ colorMode: mode })}
            />
          ))}
        </div>
        {activeTheme && !activeTheme.builtin ? (
          <p className="settings-help">
            {activeTheme.name} is a {activeTheme.appearance} theme. In{" "}
            {activeTheme.appearance === "dark" ? "light" : "dark"} mode the default palette shows
            instead.
          </p>
        ) : null}
      </section>

      <section className="appearance-section">
        <div className="appearance-section-head">
          <h3>Theme</h3>
          <div className="appearance-section-actions">
            <button type="button" className="ghost-button" onClick={() => void startCreate()}>
              <IconPaint />
              Create theme
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => importRef.current?.click()}
            >
              <IconPlus />
              Import theme
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importFile(file);
              }}
            />
          </div>
        </div>
        <p className="settings-help">
          Themes live as JSON under{" "}
          <code className="mono">{catalog?.themesDir ?? "AGE_HOME/themes"}</code>.
        </p>
        <div className="theme-card-grid">
          {(catalog?.themes ?? []).map((theme) => {
            const isActive = active === theme.id;
            return (
              <article
                key={theme.id}
                className={isActive ? "theme-library-card active" : "theme-library-card"}
                data-theme-library-card={theme.id}
              >
                <button
                  type="button"
                  className="theme-library-card-body"
                  disabled={busy}
                  onClick={() => void applyTheme(theme.id)}
                >
                  <div className="theme-preview-row">
                    <ThemePreviewCircle
                      colors={previewColorsFor(theme)}
                      mode={theme.appearance}
                      picked={isActive}
                    />
                  </div>
                  <span className="theme-library-card-label">{theme.name}</span>
                </button>
                <div className="theme-library-card-actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={theme.builtin ? `View ${theme.name}` : `Edit ${theme.name}`}
                    title={theme.builtin ? "View" : "Edit"}
                    onClick={() => void openTheme(theme.id)}
                  >
                    <IconPaint />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Duplicate ${theme.name}`}
                    title="Duplicate"
                    onClick={() => void duplicateTheme(theme.id)}
                  >
                    <IconCopy />
                  </button>
                  {!theme.builtin ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Delete ${theme.name}`}
                      title="Delete"
                      disabled={busy}
                      onClick={() => {
                        void (async () => {
                          setBusy(true);
                          setError(null);
                          try {
                            await deleteTheme(theme.id);
                            await refresh();
                          } catch (err) {
                            setError(
                              err instanceof Error ? err.message : "Could not delete theme.",
                            );
                          } finally {
                            setBusy(false);
                          }
                        })();
                      }}
                    >
                      <IconTrash />
                    </button>
                  ) : null}
                  {isActive ? (
                    <span className="theme-active-pill" title="Active">
                      <IconCheck />
                    </span>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {editing ? (
        <ThemeEditor
          key={editing.id}
          initial={editing}
          busy={busy}
          onSave={persist}
          onDelete={
            editing.builtin || !catalog?.themes.some((t) => t.id === editing.id)
              ? null
              : () => void remove()
          }
          onClose={() => setEditing(null)}
        />
      ) : null}

      <section className="appearance-section">
        <h3>Interface</h3>
        <div className="settings-card appearance-interface">
          <InterfaceRow
            title="Contrast"
            description="Adjust the contrast of colors and borders across the interface."
            reset={
              contrast !== DEFAULTS.appearanceContrast ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    void patchDeviceSettings({
                      appearanceContrast: DEFAULTS.appearanceContrast,
                    })
                  }
                >
                  Reset
                </button>
              ) : null
            }
            control={
              <SliderControl
                id="appearance-contrast"
                label="Contrast"
                value={contrast}
                min={50}
                max={150}
                step={5}
                format={(n) => `${n}%`}
                onChange={(appearanceContrast) => void patchDeviceSettings({ appearanceContrast })}
              />
            }
          />
          <InterfaceRow
            title="Glass opacity"
            description="Higher values make menus, dialogs, and the composer more solid."
            reset={
              glass !== DEFAULTS.glassOpacity ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void patchDeviceSettings({ glassOpacity: DEFAULTS.glassOpacity })}
                >
                  Reset
                </button>
              ) : null
            }
            control={
              <SliderControl
                id="glass-opacity"
                label="Glass opacity"
                value={glass}
                min={40}
                max={100}
                step={5}
                format={(n) => `${n}%`}
                onChange={(glassOpacity) => void patchDeviceSettings({ glassOpacity })}
              />
            }
          />
          <InterfaceRow
            title="Chat width"
            description="Set how wide messages and the composer can grow on large screens."
            reset={
              chatWidth !== DEFAULTS.chatWidth ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void patchDeviceSettings({ chatWidth: DEFAULTS.chatWidth })}
                >
                  Reset
                </button>
              ) : null
            }
            control={
              <select
                className="settings-select"
                aria-label="Chat width"
                value={chatWidth}
                onChange={(event) =>
                  void patchDeviceSettings({
                    chatWidth: event.target.value as DeviceSettingsValue["chatWidth"],
                  })
                }
              >
                <option value="comfortable">Comfortable (default)</option>
                <option value="wide">Wide</option>
                <option value="full">Full</option>
              </select>
            }
          />
        </div>
      </section>

      {error ? <p className="empty-state error small">{error}</p> : null}
    </div>
  );
}

function ModeTile({
  mode,
  active,
  theme,
  onSelect,
}: {
  mode: ColorMode;
  active: boolean;
  theme: AppearanceThemeSummary | null;
  onSelect: () => void;
}) {
  const panes = useMemo(() => {
    if (mode === "system") {
      return [
        { clip: "left" as const, colors: wireframeColors("light", theme) },
        { clip: "right" as const, colors: wireframeColors("dark", theme) },
      ];
    }
    return [{ colors: wireframeColors(mode, theme) }];
  }, [mode, theme]);

  return (
    <button
      type="button"
      className={active ? "appearance-mode-tile active" : "appearance-mode-tile"}
      aria-pressed={active}
      aria-label={mode === "system" ? "Follow the system appearance" : `Use ${mode} mode`}
      onClick={onSelect}
    >
      <span className="theme-wireframe">
        {panes.map((pane, index) => (
          <ThemeWireframePane
            key={index}
            colors={pane.colors}
            clip={"clip" in pane ? pane.clip : undefined}
          />
        ))}
      </span>
      <span>{mode === "system" ? "System" : mode === "light" ? "Light" : "Dark"}</span>
    </button>
  );
}

function ThemeWireframePane({ colors, clip }: { colors: PreviewColors; clip?: "left" | "right" }) {
  const line = "color-mix(in srgb, var(--text) 25%, transparent)";
  return (
    <span
      className="theme-wireframe-pane"
      style={
        clip
          ? {
              clipPath:
                clip === "left"
                  ? "polygon(0 0, calc(50% - 1px) 0, calc(50% - 1px) 100%, 0 100%)"
                  : "polygon(calc(50% + 1px) 0, 100% 0, 100% 100%, calc(50% + 1px) 100%)",
            }
          : undefined
      }
    >
      <span className="tw-canvas" style={{ background: colors.canvas }} />
      <span
        className="tw-sidebar"
        style={{ background: colors.sidebar, boxShadow: `inset -1px 0 0 ${line}` }}
      />
      <span
        className="tw-block tw-a"
        style={{ background: colors.surface, boxShadow: `inset 0 0 0 1px ${line}` }}
      />
      <span className="tw-block tw-b" style={{ background: colors.accentSurface }} />
      <span className="tw-block tw-c" style={{ background: colors.messageSurface, opacity: 0.7 }} />
      <span className="tw-msg" style={{ background: colors.messageSurface }} />
      <span
        className="tw-composer"
        style={{ background: colors.surface, boxShadow: `inset 0 0 0 1px ${line}` }}
      >
        <span style={{ background: line, opacity: 0.7 }} />
        <span style={{ background: colors.messageAction }} />
      </span>
    </span>
  );
}

function ThemePreviewCircle({
  colors,
  mode,
  picked,
}: {
  colors: PreviewColors;
  mode: "light" | "dark";
  picked: boolean;
}) {
  const style: CSSProperties = {
    backgroundColor: colors.canvas,
    backgroundImage: [
      `radial-gradient(circle at 30% 30%, ${colors.accent} 0%, color-mix(in srgb, ${colors.accent} 40%, transparent) 42%, transparent 70%)`,
      `radial-gradient(circle at 72% 68%, color-mix(in srgb, ${colors.messageAction} 70%, transparent) 0%, transparent 55%)`,
    ].join(", "),
    boxShadow:
      mode === "dark"
        ? "inset 0 0 0 1px rgb(255 255 255 / 0.14), 0 1px 2px rgb(0 0 0 / 0.18)"
        : "inset 0 0 0 1px rgb(0 0 0 / 0.10), 0 1px 2px rgb(0 0 0 / 0.08)",
  };
  return (
    <span className={picked ? "theme-preview-circle picked" : "theme-preview-circle"}>
      <span className="theme-preview-blob" style={style} />
      {picked ? (
        <span className="theme-preview-badge" aria-hidden="true">
          {mode === "light" ? <IconSun /> : <IconMoon />}
        </span>
      ) : null}
    </span>
  );
}

function InterfaceRow({
  title,
  description,
  control,
  reset,
}: {
  title: string;
  description: string;
  control: ReactNode;
  reset: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <p className="setting-title">
          {title}
          {reset}
        </p>
        <p className="setting-desc">{description}</p>
      </div>
      <div className="setting-control">{control}</div>
    </div>
  );
}

function SliderControl({
  id,
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (n: number) => string;
  onChange: (n: number) => void;
}) {
  const ratio = (value - min) / (max - min);
  return (
    <div className="appearance-slider">
      <output className="appearance-slider-value" htmlFor={id}>
        {format(value)}
      </output>
      <input
        id={id}
        aria-label={label}
        className="settings-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--settings-slider-progress": `${ratio * 100}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </div>
  );
}

function previewColorsFor(theme: AppearanceThemeSummary): PreviewColors {
  return wireframeColors(theme.appearance, theme);
}

function wireframeColors(
  mode: "light" | "dark",
  theme: AppearanceThemeSummary | null,
): PreviewColors {
  if (theme && theme.appearance === mode) {
    const canvas = theme.canvas;
    const accent = theme.accent;
    const surface = mix(
      canvas,
      mode === "dark" ? "#ffffff" : "#000000",
      mode === "dark" ? 0.08 : 0.04,
    );
    const sidebar = mix(canvas, mode === "dark" ? "#000000" : "#ffffff", 0.12);
    return {
      canvas,
      sidebar,
      surface,
      accentSurface: mix(surface, accent, 0.18),
      accent,
      messageSurface: mix(
        canvas,
        mode === "dark" ? "#ffffff" : "#000000",
        mode === "dark" ? 0.14 : 0.08,
      ),
      messageAction: accent,
    };
  }
  if (mode === "light") {
    return {
      canvas: "#f4f3ef",
      sidebar: "#fafafa",
      surface: "#ffffff",
      accentSurface: "#f4f4f5",
      accent: theme?.accent ?? "#7c6a46",
      messageSurface: "#e4e4e7",
      messageAction: theme?.accent ?? "#7c6a46",
    };
  }
  return {
    canvas: theme?.canvas ?? "#0f0f10",
    sidebar: "#0f0f10",
    surface: "#121212",
    accentSurface: "#27272a",
    accent: theme?.accent ?? "#d7c9a7",
    messageSurface: "#27272a",
    messageAction: theme?.accent ?? "#d7c9a7",
  };
}

function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return a;
  const m = (i: 0 | 1 | 2) => Math.round(pa[i] + (pb[i] - pa[i]) * t);
  return `#${[m(0), m(1), m(2)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(hex: string): [number, number, number] | null {
  const raw = hex.replace("#", "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw.slice(0, 6);
  if (full.length !== 6) return null;
  const n = Number.parseInt(full, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
