import type { AppearanceThemeSummary } from "@age/contracts";
import { memo, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { getTheme } from "../../state/appearance.ts";
import { useStore } from "../../state/store.ts";
import { PREVIEW_RING } from "../../state/theme-data.ts";
import { IconCheck, IconCopy, IconMoon, IconPaint, IconSun, IconTrash } from "../Icons.tsx";
import { groupThemes, themeBadges, wallpaperOf } from "./helpers.ts";

const thumbnailCache = new Map<string, string>();

export const ThemeGallery = memo(function ThemeGallery({
  themes,
  busy,
  dragging,
  onDragging,
  onActivate,
  onEdit,
  onDuplicate,
  onDelete,
  onDropFile,
}: {
  themes: AppearanceThemeSummary[];
  busy: boolean;
  dragging: boolean;
  onDragging: (value: boolean) => void;
  onActivate: (id: string) => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onDropFile: (file: File) => void;
}) {
  const activeThemeId = useStore((state) => state.deviceSettings?.activeThemeId ?? "default");
  const groups = groupThemes(themes);
  const ids = groups.flatMap((group) => group.themes.map((theme) => theme.id));
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const moveFocus = (from: string, key: string, grid: HTMLElement | null) => {
    const cols = columnCount(grid);
    const delta =
      key === "ArrowLeft"
        ? -1
        : key === "ArrowRight"
          ? 1
          : key === "ArrowUp"
            ? -cols
            : key === "ArrowDown"
              ? cols
              : 0;
    if (!delta) return;
    const index = ids.indexOf(from);
    if (index < 0) return;
    const next = ids[index + delta];
    if (next) buttons.current.get(next)?.focus();
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    onDragging(true);
  };

  return (
    <div
      className={dragging ? "theme-gallery drop-target" : "theme-gallery"}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={() => onDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        onDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) onDropFile(file);
      }}
    >
      {groups.map((group) => (
        <section key={group.id} className="theme-gallery-group">
          <h4>{group.label}</h4>
          <div className="theme-card-grid">
            {group.themes.map((theme) => {
              const selected = theme.id === activeThemeId;
              const badges = themeBadges(theme);
              return (
                <article
                  key={theme.id}
                  className={selected ? "theme-library-card active" : "theme-library-card"}
                  data-theme-library-card={theme.id}
                >
                  <button
                    type="button"
                    className="theme-library-card-body"
                    disabled={busy}
                    aria-pressed={selected}
                    aria-label={`Use ${theme.name}`}
                    ref={(node) => {
                      if (node) buttons.current.set(theme.id, node);
                      else buttons.current.delete(theme.id);
                    }}
                    onClick={() => onActivate(theme.id)}
                    onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                      if (
                        event.key === "ArrowLeft" ||
                        event.key === "ArrowRight" ||
                        event.key === "ArrowUp" ||
                        event.key === "ArrowDown"
                      ) {
                        event.preventDefault();
                        moveFocus(theme.id, event.key, event.currentTarget);
                      }
                    }}
                  >
                    <div
                      className="theme-card-preview"
                      style={{
                        background: theme.canvas,
                        boxShadow: PREVIEW_RING[theme.appearance],
                      }}
                    >
                      {theme.hasWallpaper ? <WallpaperThumb themeId={theme.id} /> : null}
                      <span
                        className="theme-card-swatch"
                        style={{ background: theme.accent }}
                        aria-hidden="true"
                      />
                      {selected ? (
                        <span className="theme-preview-badge" aria-hidden="true">
                          {theme.appearance === "light" ? <IconSun /> : <IconMoon />}
                        </span>
                      ) : null}
                    </div>
                    <span className="theme-library-card-label">{theme.name}</span>
                    {badges.length > 0 ? (
                      <span className="theme-card-badges">
                        {badges.map((badge) => (
                          <span key={badge} className="theme-card-badge">
                            {badge}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </button>
                  <div className="theme-library-card-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={theme.builtin ? `View ${theme.name}` : `Edit ${theme.name}`}
                      title={theme.builtin ? "View" : "Edit"}
                      onClick={() => onEdit(theme.id)}
                    >
                      <IconPaint />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Duplicate ${theme.name}`}
                      title="Duplicate"
                      onClick={() => onDuplicate(theme.id)}
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
                        onClick={() => onDelete(theme.id)}
                      >
                        <IconTrash />
                      </button>
                    ) : null}
                    {selected ? (
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
      ))}
      {themes.length === 0 ? <p className="settings-help">No themes yet.</p> : null}
    </div>
  );
});

function WallpaperThumb({ themeId }: { themeId: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(() => thumbnailCache.get(themeId) ?? null);

  // sync: load wallpaper thumbnail when the card enters the viewport
  useEffect(() => {
    if (src) return;
    const node = ref.current;
    if (!node) return;
    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void getTheme(themeId).then(
        (theme) => {
          if (cancelled) return;
          const image = wallpaperOf(theme).image;
          if (!image) return;
          thumbnailCache.set(themeId, image);
          setSrc(image);
        },
        () => undefined,
      );
    });
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [themeId, src]);

  return (
    <span
      ref={ref}
      className="theme-card-thumb"
      style={src ? { backgroundImage: `url("${src}")` } : undefined}
      aria-hidden="true"
    />
  );
}

function columnCount(from: HTMLElement | null): number {
  const grid = from?.closest(".theme-card-grid");
  if (!grid) return 1;
  const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean);
  return Math.max(1, columns.length);
}
