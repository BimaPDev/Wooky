import type { AppearanceThemeSummary } from "@wooky/contracts";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { getTheme } from "../../state/appearance.ts";
import { useStore } from "../../state/store.ts";
import { PREVIEW_RING } from "../../state/theme-data.ts";
import { IconCheck, IconCopy, IconMoon, IconPaint, IconSun, IconTrash } from "../Icons.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { dropHasFiles, groupThemes, isThemeDropFile, themeBadges, wallpaperOf } from "./helpers.ts";
import { cachedWallpaperThumb } from "./thumbnails.ts";

export const ThemeGallery = memo(function ThemeGallery({
  themes,
  dropEnabled,
  dragging,
  onDragging,
  onActivate,
  onEdit,
  onDuplicate,
  onDelete,
  onDropFile,
}: {
  themes: AppearanceThemeSummary[];
  dropEnabled: boolean;
  dragging: boolean;
  onDragging: (value: boolean) => void;
  onActivate: (id: string) => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onDropFile: (file: File) => void;
}) {
  const activeThemeId = useStore((state) => state.deviceSettings?.activeThemeId ?? "default");
  const groups = useMemo(() => groupThemes(themes), [themes]);
  const ids = useMemo(
    () => groups.flatMap((group) => group.themes.map((theme) => theme.id)),
    [groups],
  );
  const idOrder = useRef(ids);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const dragDepth = useRef(0);

  // sync: keep arrow-key order in a ref so memoized cards stay stable
  useEffect(() => {
    idOrder.current = ids;
  }, [ids]);

  const registerBody = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) buttons.current.set(id, node);
    else buttons.current.delete(id);
  }, []);

  const onArrow = useCallback(
    (from: string, key: string, grid: HTMLElement | null) => {
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
      const order = idOrder.current;
      const index = order.indexOf(from);
      if (index < 0) return;
      const next = order[index + delta];
      if (next) buttons.current.get(next)?.focus();
    },
    [idOrder, buttons],
  );

  const acceptDrag = (event: DragEvent<HTMLDivElement>) => {
    if (!dropEnabled || !dropHasFiles(event.dataTransfer.types)) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    return true;
  };

  return (
    <div
      className={dragging ? "theme-gallery drop-target" : "theme-gallery"}
      role="listbox"
      aria-label="Installed themes"
      aria-activedescendant={`theme-option-${activeThemeId}`}
      onDragEnter={(event) => {
        if (!acceptDrag(event)) return;
        dragDepth.current += 1;
        onDragging(true);
      }}
      onDragOver={(event) => {
        acceptDrag(event);
      }}
      onDragLeave={(event) => {
        if (!dropHasFiles(event.dataTransfer.types)) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          onDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        onDragging(false);
        if (!dropEnabled) return;
        const file = event.dataTransfer.files[0];
        if (file && isThemeDropFile(file)) onDropFile(file);
      }}
    >
      {groups.map((group) => (
        <section
          key={group.id}
          className="theme-gallery-group"
          role="group"
          aria-label={group.label}
        >
          <h4>{group.label}</h4>
          <div className="theme-card-grid">
            {group.themes.map((theme) => (
              <ThemeCard
                key={theme.id}
                theme={theme}
                selected={theme.id === activeThemeId}
                onActivate={onActivate}
                onEdit={onEdit}
                onDuplicate={onDuplicate}
                onDelete={onDelete}
                registerBody={registerBody}
                onArrow={onArrow}
              />
            ))}
          </div>
        </section>
      ))}
      {themes.length === 0 ? <p className="settings-help">No themes yet.</p> : null}
    </div>
  );
});

const ThemeCard = memo(function ThemeCard({
  theme,
  selected,
  onActivate,
  onEdit,
  onDuplicate,
  onDelete,
  registerBody,
  onArrow,
}: {
  theme: AppearanceThemeSummary;
  selected: boolean;
  onActivate: (id: string) => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  registerBody: (id: string, node: HTMLButtonElement | null) => void;
  onArrow: (from: string, key: string, node: HTMLElement | null) => void;
}) {
  const badges = themeBadges(theme);
  return (
    <article
      className={selected ? "theme-library-card active" : "theme-library-card"}
      data-theme-library-card={theme.id}
      role="option"
      id={`theme-option-${theme.id}`}
      aria-selected={selected}
      aria-label={theme.name}
    >
      <button
        type="button"
        className="theme-library-card-body"
        aria-label={`Use ${theme.name}`}
        ref={(node) => registerBody(theme.id, node)}
        onClick={() => onActivate(theme.id)}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (
            event.key === "ArrowLeft" ||
            event.key === "ArrowRight" ||
            event.key === "ArrowUp" ||
            event.key === "ArrowDown"
          ) {
            event.preventDefault();
            onArrow(theme.id, event.key, event.currentTarget);
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
        <Tooltip label={theme.builtin ? "View" : "Edit"}>
          <button
            type="button"
            className="icon-button"
            aria-label={theme.builtin ? `View ${theme.name}` : `Edit ${theme.name}`}
            onClick={() => onEdit(theme.id)}
          >
            <IconPaint />
          </button>
        </Tooltip>
        <Tooltip label="Duplicate">
          <button
            type="button"
            className="icon-button"
            aria-label={`Duplicate ${theme.name}`}
            onClick={() => onDuplicate(theme.id)}
          >
            <IconCopy />
          </button>
        </Tooltip>
        {!theme.builtin ? (
          <Tooltip label="Delete">
            <button
              type="button"
              className="icon-button"
              aria-label={`Delete ${theme.name}`}
              onClick={() => onDelete(theme.id)}
            >
              <IconTrash />
            </button>
          </Tooltip>
        ) : null}
        {selected ? (
          <span className="theme-active-pill" title="Active">
            <IconCheck />
          </span>
        ) : null}
      </div>
    </article>
  );
});

function WallpaperThumb({ themeId }: { themeId: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);

  // sync: load a downscaled wallpaper thumbnail when the card enters the viewport
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void getTheme(themeId).then(
        async (theme) => {
          const image = wallpaperOf(theme).image;
          if (!image || cancelled) return;
          try {
            const thumb = await cachedWallpaperThumb(themeId, image);
            if (!cancelled) setSrc(thumb);
          } catch {
            if (!cancelled) setSrc(null);
          }
        },
        () => undefined,
      );
    });
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [themeId]);

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
