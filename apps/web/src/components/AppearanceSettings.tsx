import {
  type AppearanceTheme as Theme,
  type AppearanceThemeSummary,
  type DeviceSettings as DeviceSettingsValue,
} from "@age/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  deleteTheme,
  getTheme,
  listThemes,
  loadDeviceSettings,
  patchDeviceSettings,
  saveTheme,
} from "../state/appearance.ts";
import { useStore } from "../state/store.ts";
import { BLACK, WHITE, WIREFRAME_DEFAULTS } from "../state/theme-data.ts";
import { IconPaint, IconPlus } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { ThemeEditor } from "./ThemeEditor.tsx";
import { ThemeGallery } from "./theme-studio/ThemeGallery.tsx";
import { WallpaperControls } from "./theme-studio/WallpaperControls.tsx";
import { importedStatusText, readFileAsText, themeFileTooLarge } from "./theme-studio/helpers.ts";
import { activateListedTheme, importThemeText } from "./theme-studio/rpc.ts";

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
  const active = useStore((state) => state.deviceSettings?.activeThemeId ?? "default");
  const colorMode = useStore((state) => state.deviceSettings?.colorMode ?? "system");
  const wallpaperMotion = useStore((state) => state.deviceSettings?.wallpaperMotion ?? "on");
  const contrast = useStore(
    (state) => state.deviceSettings?.appearanceContrast ?? DEFAULTS.appearanceContrast,
  );
  const glass = useStore((state) => state.deviceSettings?.glassOpacity ?? DEFAULTS.glassOpacity);
  const chatWidth = useStore((state) => state.deviceSettings?.chatWidth ?? DEFAULTS.chatWidth);
  const [catalog, setCatalog] = useState<{
    themesDir: string;
    themes: AppearanceThemeSummary[];
  } | null>(null);
  const [editing, setEditing] = useState<Theme | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const listed = await listThemes();
    setCatalog({ themesDir: listed.themesDir, themes: listed.themes });
    await loadDeviceSettings();
  }, []);

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

  const openTheme = useCallback(async (id: string) => {
    setError(null);
    try {
      setEditing(await getTheme(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open theme.");
    }
  }, []);

  const applyTheme = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const summary = catalog?.themes.find((theme) => theme.id === id);
        await activateListedTheme(id, summary?.appearance ?? "dark");
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not apply theme.");
      } finally {
        setBusy(false);
      }
    },
    [catalog, refresh],
  );

  const duplicateTheme = useCallback(async (id: string) => {
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
  }, []);

  const persist = async (theme: Theme) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await saveTheme(theme);
      setEditing(null);
      await activateListedTheme(saved.id, saved.appearance);
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

  const importText = useCallback(
    async (text: string, filename?: string) => {
      if (themeFileTooLarge(new TextEncoder().encode(text).byteLength)) {
        setStatus(null);
        setError("That file is larger than 6 MB.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await importThemeText(text, filename);
        setStatus(importedStatusText(result.theme.name, result.format));
        await refresh();
      } catch (err) {
        setStatus(null);
        setError(err instanceof Error ? err.message : "Could not import theme.");
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const importFile = useCallback(
    async (file: File) => {
      if (themeFileTooLarge(file.size)) {
        setStatus(null);
        setError("That file is larger than 6 MB.");
        return;
      }
      try {
        await importText(await readFileAsText(file), file.name);
      } catch (err) {
        setStatus(null);
        setError(err instanceof Error ? err.message : "Could not import theme.");
      }
    },
    [importText],
  );

  const onDelete = useCallback(
    (id: string) => {
      void (async () => {
        setBusy(true);
        setError(null);
        try {
          await deleteTheme(id);
          await refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not delete theme.");
        } finally {
          setBusy(false);
        }
      })();
    },
    [refresh],
  );

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
        {activeTheme && !activeTheme.builtin && activeTheme.modes.length < 2 ? (
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
            <button type="button" className="ghost-button" onClick={() => setPasteOpen(true)}>
              Paste JSON
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json,image/svg+xml,.svg"
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
          <code className="mono">{catalog?.themesDir ?? "AGE_HOME/themes"}</code>. Drag a .json or
          .svg file onto the gallery to import it.
        </p>
        {status ? (
          <p className="theme-import-status" role="status">
            {status}
          </p>
        ) : null}
        <ThemeGallery
          themes={catalog?.themes ?? []}
          busy={busy}
          dragging={dragging}
          onDragging={setDragging}
          onActivate={applyTheme}
          onEdit={openTheme}
          onDuplicate={duplicateTheme}
          onDelete={onDelete}
          onDropFile={importFile}
        />
      </section>

      {activeTheme?.hasWallpaper ? (
        <WallpaperControls
          themeId={active}
          busy={busy}
          onBusy={setBusy}
          onError={setError}
          onCatalogChanged={refresh}
        />
      ) : null}

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

      {pasteOpen ? (
        <PasteThemeDialog
          busy={busy}
          onClose={() => setPasteOpen(false)}
          onImport={(text) => {
            setPasteOpen(false);
            void importText(text, "pasted.json");
          }}
        />
      ) : null}

      <section className="appearance-section">
        <h3>Interface</h3>
        <div className="settings-card appearance-interface">
          <InterfaceRow
            title="Animate wallpapers"
            description="Wallpapers stay still when the window is hidden or reduced motion is on."
            reset={null}
            control={
              <button
                type="button"
                role="switch"
                aria-checked={wallpaperMotion === "on"}
                aria-label="Animate wallpapers"
                className={wallpaperMotion === "on" ? "toggle on" : "toggle"}
                onClick={() =>
                  void patchDeviceSettings({
                    wallpaperMotion: wallpaperMotion === "on" ? "off" : "on",
                  })
                }
              >
                <span className="toggle-thumb" />
              </button>
            }
          />
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

function PasteThemeDialog({
  busy,
  onClose,
  onImport,
}: {
  busy: boolean;
  onClose: () => void;
  onImport: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <Modal label="Paste JSON" onClose={onClose} className="modal small">
      <div className="theme-paste-dialog">
        <header className="theme-paste-head">
          <h3>Paste JSON</h3>
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
        </header>
        <textarea
          className="theme-paste-input mono"
          rows={12}
          spellCheck={false}
          value={text}
          aria-label="Theme JSON"
          placeholder='{ "id": "paper", "name": "Paper", ... }'
          onChange={(event) => setText(event.target.value)}
        />
        <div className="theme-paste-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy || !text.trim()}
            onClick={() => onImport(text)}
          >
            Import
          </button>
        </div>
      </div>
    </Modal>
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

function wireframeColors(
  mode: "light" | "dark",
  theme: AppearanceThemeSummary | null,
): PreviewColors {
  if (theme && theme.appearance === mode) {
    const canvas = theme.canvas;
    const accent = theme.accent;
    const surface = mix(canvas, mode === "dark" ? WHITE : BLACK, mode === "dark" ? 0.08 : 0.04);
    const sidebar = mix(canvas, mode === "dark" ? BLACK : WHITE, 0.12);
    return {
      canvas,
      sidebar,
      surface,
      accentSurface: mix(surface, accent, 0.18),
      accent,
      messageSurface: mix(canvas, mode === "dark" ? WHITE : BLACK, mode === "dark" ? 0.14 : 0.08),
      messageAction: accent,
    };
  }
  const fallback = WIREFRAME_DEFAULTS[mode];
  return {
    ...fallback,
    canvas: mode === "dark" ? (theme?.canvas ?? fallback.canvas) : fallback.canvas,
    accent: theme?.accent ?? fallback.accent,
    messageAction: theme?.accent ?? fallback.messageAction,
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
