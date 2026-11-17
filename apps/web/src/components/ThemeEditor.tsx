import {
  AppearanceTheme,
  type ThemeBackground,
  type ThemeFonts,
  type ThemeShape,
} from "@age/contracts";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ROLE_TO_VAR,
  previewThemeLocally,
  resolvePalette,
  restoreSavedTheme,
  type ColorRole,
} from "../state/appearance.ts";
import { IconClose, IconCopy, IconTrash } from "./Icons.tsx";

type Theme = AppearanceTheme;
type Tab = "colors" | "type" | "layout" | "background" | "css";

const TABS: { id: Tab; label: string }[] = [
  { id: "colors", label: "Colors" },
  { id: "type", label: "Typography" },
  { id: "layout", label: "Layout" },
  { id: "background", label: "Background" },
  { id: "css", label: "Custom CSS" },
];

const ROLE_GROUPS: { title: string; roles: [ColorRole, string][] }[] = [
  {
    title: "Surfaces",
    roles: [
      ["bg0", "Canvas / sidebar"],
      ["bg1", "Workspace"],
      ["bg2", "Cards and menus"],
      ["bg3", "Raised"],
      ["bgHover", "Hover"],
      ["bgActive", "Pressed"],
    ],
  },
  {
    title: "Text and lines",
    roles: [
      ["text", "Primary text"],
      ["text2", "Secondary text"],
      ["text3", "Muted text"],
      ["text4", "Faint text"],
      ["line", "Hairline"],
      ["lineStrong", "Strong line"],
    ],
  },
  {
    title: "Accent",
    roles: [
      ["accent", "Accent"],
      ["accentInk", "Text on accent"],
      ["focus", "Focus ring"],
    ],
  },
  {
    title: "Status",
    roles: [
      ["amber", "Waiting"],
      ["amberBg", "Waiting surface"],
      ["red", "Error"],
      ["redBg", "Error surface"],
      ["green", "Success"],
    ],
  },
  {
    title: "Diff",
    roles: [
      ["addBg", "Added line"],
      ["addInk", "Added text"],
      ["delBg", "Removed line"],
      ["delInk", "Removed text"],
    ],
  },
  {
    title: "Providers",
    roles: [
      ["providerClaude", "Claude"],
      ["providerCursor", "Cursor"],
      ["providerCodex", "Codex"],
      ["providerDemo", "Demo"],
    ],
  },
];

const UI_FONTS = [
  { label: "System default", value: "" },
  { label: "Inter", value: "Inter" },
  { label: "Segoe UI", value: '"Segoe UI Variable", "Segoe UI"' },
  { label: "SF Pro", value: '-apple-system, "SF Pro Text"' },
  { label: "Geist", value: "Geist" },
  { label: "IBM Plex Sans", value: '"IBM Plex Sans"' },
  { label: "Roboto", value: "Roboto" },
  { label: "Georgia (serif)", value: "Georgia, serif" },
  { label: "Monospace everywhere", value: '"JetBrains Mono", Consolas, monospace' },
];

const MONO_FONTS = [
  { label: "System default", value: "" },
  { label: "JetBrains Mono", value: '"JetBrains Mono"' },
  { label: "Cascadia Code", value: '"Cascadia Code"' },
  { label: "Fira Code", value: '"Fira Code"' },
  { label: "Consolas", value: "Consolas" },
  { label: "Geist Mono", value: '"Geist Mono"' },
  { label: "IBM Plex Mono", value: '"IBM Plex Mono"' },
];

const CSS_VARS = [
  ...Object.values(ROLE_TO_VAR),
  "--font-ui",
  "--font-mono",
  "--text-base",
  "--radius",
  "--space-2",
  "--sidebar-width",
  "--content-width",
  "--glass-opacity",
];

export function ThemeEditor({
  initial,
  busy,
  onSave,
  onDelete,
  onClose,
}: {
  initial: Theme;
  busy: boolean;
  onSave: (theme: Theme) => Promise<void>;
  onDelete: (() => void) | null;
  onClose: () => void;
}) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [tab, setTab] = useState<Tab>("colors");
  const [error, setError] = useState<string | null>(null);
  const fork = Boolean(initial.builtin);

  // sync: live-preview the draft in the document stylesheet; restore the saved theme on close
  useEffect(() => {
    previewThemeLocally(theme);
  }, [theme]);
  // sync: undo the live preview when the editor unmounts
  useEffect(() => () => restoreSavedTheme(), []);

  const palette = useMemo(() => resolvePalette(theme), [theme]);
  const patch = (next: Partial<Theme>) => setTheme((current) => ({ ...current, ...next }));
  const patchFonts = (next: Partial<ThemeFonts>) =>
    patch({ fonts: clean({ ...theme.fonts, ...next }) });
  const patchShape = (next: Partial<ThemeShape>) =>
    patch({ shape: clean({ ...theme.shape, ...next }) });
  const patchBackground = (next: Partial<ThemeBackground>) =>
    patch({ background: clean({ ...theme.background, ...next }) });

  const save = async () => {
    setError(null);
    const draft = fork
      ? { ...theme, id: uniqueId(theme.name), builtin: false }
      : { ...theme, builtin: false };
    const parsed = AppearanceTheme.safeParse(draft);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue ? `${issue.path.join(".") || "theme"}: ${issue.message}` : "Invalid theme.");
      return;
    }
    await onSave(parsed.data);
  };

  const exportJson = () => {
    const { builtin: _builtin, ...rest } = theme;
    const blob = new Blob([`${JSON.stringify(rest, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${theme.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="theme-studio" aria-label="Theme editor">
      <header className="theme-studio-head">
        <input
          className="theme-studio-name"
          value={theme.name}
          aria-label="Theme name"
          onChange={(event) => patch({ name: event.target.value })}
        />
        <Segmented
          label="Base appearance"
          value={theme.appearance}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
          onChange={(appearance) => patch({ appearance })}
        />
        <span className="theme-studio-spacer" />
        <button type="button" className="ghost-button" onClick={exportJson}>
          <IconCopy />
          Export
        </button>
        {onDelete ? (
          <button type="button" className="ghost-button danger" disabled={busy} onClick={onDelete}>
            <IconTrash />
            Delete
          </button>
        ) : null}
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || !theme.name.trim()}
          onClick={() => void save()}
        >
          {fork ? "Save as new theme" : "Save"}
        </button>
      </header>
      {fork ? (
        <p className="settings-help">
          Built-in themes are read-only. Your changes save as a new theme.
        </p>
      ) : null}

      <div className="theme-studio-tabs" role="tablist" aria-label="Theme sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "theme-studio-tab active" : "theme-studio-tab"}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="theme-studio-body" role="tabpanel">
        {tab === "colors" ? (
          <>
            <div className="theme-studio-hero">
              <ColorField
                label="Canvas"
                hint="Every surface derives from this."
                value={theme.canvas}
                onChange={(canvas) => patch({ canvas })}
              />
              <ColorField
                label="Accent"
                hint="Selection, focus and primary actions."
                value={theme.accent}
                onChange={(accent) => patch({ accent })}
              />
            </div>
            {ROLE_GROUPS.map((group) => (
              <div key={group.title} className="theme-role-group">
                <h4>{group.title}</h4>
                <div className="theme-role-grid">
                  {group.roles.map(([role, label]) => {
                    const override = theme.colors[role];
                    return (
                      <ColorField
                        key={role}
                        label={label}
                        hint={override ? ROLE_TO_VAR[role] : "Auto"}
                        value={override ?? palette[role]}
                        onChange={(value) => patch({ colors: { ...theme.colors, [role]: value } })}
                        onReset={
                          override
                            ? () => {
                                const { [role]: _removed, ...rest } = theme.colors;
                                patch({ colors: rest });
                              }
                            : undefined
                        }
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        ) : null}

        {tab === "type" ? (
          <div className="theme-form">
            <FontField
              label="Interface font"
              presets={UI_FONTS}
              value={theme.fonts?.ui ?? ""}
              onChange={(ui) => patchFonts({ ui: ui || undefined })}
            />
            <FontField
              label="Code font"
              presets={MONO_FONTS}
              value={theme.fonts?.mono ?? ""}
              onChange={(mono) => patchFonts({ mono: mono || undefined })}
            />
            <Row label="Text size" hint="Base size; headings and labels scale with it.">
              <Slider
                label="Text size"
                value={theme.fonts?.size ?? 13}
                min={11}
                max={18}
                step={1}
                format={(n) => `${n}px`}
                onChange={(size) => patchFonts({ size: size === 13 ? undefined : size })}
              />
            </Row>
            <p className="theme-type-sample" style={{ fontFamily: theme.fonts?.ui || undefined }}>
              The quick brown fox jumps over the lazy dog.{" "}
              <code style={{ fontFamily: theme.fonts?.mono || undefined }}>const x = 42;</code>
            </p>
          </div>
        ) : null}

        {tab === "layout" ? (
          <div className="theme-form">
            <Row label="Corner radius" hint="Buttons, cards, menus and the composer.">
              <Slider
                label="Corner radius"
                value={theme.shape?.radius ?? 6}
                min={0}
                max={20}
                step={1}
                format={(n) => `${n}px`}
                onChange={(radius) => patchShape({ radius: radius === 6 ? undefined : radius })}
              />
            </Row>
            <Row label="Density" hint="Spacing between and inside elements.">
              <Segmented
                label="Density"
                value={theme.shape?.density ?? "cozy"}
                options={[
                  { value: "compact", label: "Compact" },
                  { value: "cozy", label: "Default" },
                  { value: "comfortable", label: "Roomy" },
                ]}
                onChange={(density) =>
                  patchShape({ density: density === "cozy" ? undefined : density })
                }
              />
            </Row>
            <Row label="Sidebar width" hint="Width of the thread list.">
              <Slider
                label="Sidebar width"
                value={theme.shape?.sidebarWidth ?? 280}
                min={220}
                max={420}
                step={10}
                format={(n) => `${n}px`}
                onChange={(sidebarWidth) =>
                  patchShape({ sidebarWidth: sidebarWidth === 280 ? undefined : sidebarWidth })
                }
              />
            </Row>
          </div>
        ) : null}

        {tab === "background" ? (
          <BackgroundTab theme={theme} onChange={patchBackground} onError={setError} />
        ) : null}

        {tab === "css" ? (
          <div className="theme-form">
            <textarea
              className="theme-css mono"
              rows={14}
              spellCheck={false}
              value={theme.css}
              aria-label="Custom CSS"
              placeholder={".thread-title {\n  letter-spacing: -0.01em;\n}"}
              onChange={(event) => patch({ css: event.target.value })}
            />
            <p className="settings-help">
              Applied after the theme, live. Any selector works; no @import, and url() only with
              data: or #. Variables you can use or override:
            </p>
            <div className="theme-var-list">
              {CSS_VARS.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="theme-var"
                  title="Insert"
                  onClick={() =>
                    patch({
                      css: `${theme.css}${theme.css && !theme.css.endsWith("\n") ? "\n" : ""}:root { ${name}: ; }\n`,
                    })
                  }
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {error ? <p className="empty-state error small">{error}</p> : null}
    </section>
  );
}

function BackgroundTab({
  theme,
  onChange,
  onError,
}: {
  theme: Theme;
  onChange: (next: Partial<ThemeBackground>) => void;
  onError: (message: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const bg = theme.background ?? {};
  const pick = async (file: File) => {
    onError(null);
    try {
      onChange({ image: await imageToDataUrl(file) });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not read that image.");
    }
  };
  return (
    <div className="theme-form">
      <div
        className="theme-bg-drop"
        style={bg.image ? ({ backgroundImage: `url("${bg.image}")` } as CSSProperties) : undefined}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files[0];
          if (file) void pick(file);
        }}
      >
        <div className="theme-bg-actions">
          <button type="button" className="button" onClick={() => input.current?.click()}>
            {bg.image ? "Replace image" : "Choose image"}
          </button>
          {bg.image ? (
            <button type="button" className="button" onClick={() => onChange({ image: undefined })}>
              <IconClose />
              Remove
            </button>
          ) : (
            <span className="muted">or drop one here</span>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void pick(file);
          }}
        />
      </div>
      <Row label="Fit" hint="How the image fills the window.">
        <Segmented
          label="Fit"
          value={bg.fit ?? "cover"}
          options={[
            { value: "cover", label: "Fill" },
            { value: "contain", label: "Fit" },
            { value: "tile", label: "Tile" },
          ]}
          onChange={(fit) => onChange({ fit: fit === "cover" ? undefined : fit })}
        />
      </Row>
      <Row label="Dim" hint="Canvas-coloured veil over the image, for legibility.">
        <Slider
          label="Dim"
          value={bg.dim ?? 35}
          min={0}
          max={90}
          step={5}
          format={(n) => `${n}%`}
          onChange={(dim) => onChange({ dim })}
        />
      </Row>
      <Row label="Blur" hint="Soften the image behind the interface.">
        <Slider
          label="Blur"
          value={bg.blur ?? 0}
          min={0}
          max={40}
          step={1}
          format={(n) => `${n}px`}
          onChange={(blur) => onChange({ blur: blur || undefined })}
        />
      </Row>
      <Row label="Panel opacity" hint="How solid the sidebar and panels are over the image.">
        <Slider
          label="Panel opacity"
          value={bg.surfaceOpacity ?? 82}
          min={0}
          max={100}
          step={2}
          format={(n) => `${n}%`}
          onChange={(surfaceOpacity) => onChange({ surfaceOpacity })}
        />
      </Row>
    </div>
  );
}

function ColorField({
  label,
  hint,
  value,
  onChange,
  onReset,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  onReset?: () => void;
}) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value);
  }
  return (
    <div className="color-field">
      <label className="color-swatch" style={{ background: value }}>
        <input
          type="color"
          aria-label={label}
          value={toColorInput(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="color-field-copy">
        <span className="color-field-label">{label}</span>
        <span className="color-field-hint">{hint}</span>
      </div>
      <input
        className="color-field-hex mono"
        value={text}
        aria-label={`${label} hex`}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(event.target.value))
            onChange(event.target.value.toLowerCase());
        }}
      />
      {onReset ? (
        <button
          type="button"
          className="icon-button"
          aria-label={`Reset ${label}`}
          title="Back to auto"
          onClick={onReset}
        >
          <IconClose />
        </button>
      ) : (
        <span className="color-field-pad" />
      )}
    </div>
  );
}

function FontField({
  label,
  presets,
  value,
  onChange,
}: {
  label: string;
  presets: { label: string; value: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const preset = presets.find((item) => item.value === value);
  return (
    <Row label={label} hint="Pick a preset or type any installed font list.">
      <div className="font-field">
        <select
          className="settings-select"
          aria-label={`${label} preset`}
          value={preset ? preset.value : "__custom"}
          onChange={(event) => {
            if (event.target.value !== "__custom") onChange(event.target.value);
          }}
        >
          {presets.map((item) => (
            <option key={item.label} value={item.value}>
              {item.label}
            </option>
          ))}
          <option value="__custom">Custom</option>
        </select>
        <input
          className="font-field-input"
          value={value}
          placeholder="e.g. Inter, sans-serif"
          aria-label={`${label} family`}
          style={{ fontFamily: value || undefined }}
          onChange={(event) => onChange(event.target.value.replaceAll(/[;{}<>\\]/g, ""))}
        />
      </div>
    </Row>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <p className="setting-title">{label}</p>
        <p className="setting-desc">{hint}</p>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "segmented-item active" : "segmented-item"}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
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
      <output className="appearance-slider-value">{format(value)}</output>
      <input
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

function clean<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return entries.length ? (Object.fromEntries(entries) as T) : undefined;
}

function uniqueId(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "theme"}-${Date.now().toString(36)}`;
}

function toColorInput(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{8}$/i.test(value)) return value.slice(0, 7);
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const [, a, b, c] = value;
    return `#${a}${a}${b}${b}${c}${c}`;
  }
  return "#000000";
}

/** Downscale to at most 2560px and re-encode, so a theme stays a small portable file. */
async function imageToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("That file is not an image.");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.88, 0.75, 0.6, 0.45]) {
    const url = canvas.toDataURL("image/webp", quality);
    if (url.length < 5_500_000) return url;
  }
  throw new Error("That image is too large even after compression.");
}
