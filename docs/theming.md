# Theming

A theme is one JSON file. Images are inline data URLs, so the file stays portable.
`themes.import` also accepts a t3code theme JSON file or a raw SVG, and turns either
into this format. A t3code object does not parse as an Wooky theme.

## Theme file

```json
{
  "version": 1,
  "id": "paper",
  "name": "Paper",
  "appearance": "dark",
  "canvas": "#141311",
  "accent": "#d7c9a7",
  "colors": {},
  "fonts": { "ui": "Inter, sans-serif", "mono": "ui-monospace, monospace", "size": 13 },
  "shape": { "radius": 8, "density": "cozy", "sidebarWidth": 280 },
  "background": {
    "image": "data:image/svg+xml;base64,PHN2Zy8+",
    "fit": "cover",
    "dim": 40,
    "blur": 0,
    "panelBlur": 16,
    "surfaceOpacity": 72,
    "animated": true
  },
  "variants": {
    "light": {
      "canvas": "#f4f3ef",
      "accent": "#8a6a3b",
      "colors": { "text": "#1c1b18" }
    }
  },
  "css": "",
  "builtin": false
}
```

### Fields

| Field        | Required | Meaning                                                                                                                                                |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`    | no       | Always `1`. Defaults to `1`.                                                                                                                           |
| `id`         | yes      | 1–64 characters. Lowercase letters, digits, `_` or `-`, starting with a letter or digit.                                                               |
| `name`       | yes      | 1–80 characters.                                                                                                                                       |
| `appearance` | yes      | `dark` or `light`. The mode the top-level palette describes.                                                                                           |
| `canvas`     | yes      | Hex (`#rgb`, `#rrggbb` or `#rrggbbaa`). Base surface. Derives `bg` layers when `colors` is sparse.                                                     |
| `accent`     | yes      | Hex. Derives `focus` and `accentInk` when `colors` is sparse.                                                                                          |
| `colors`     | no       | Role overrides. Defaults to `{}`. Unknown keys are rejected.                                                                                           |
| `fonts`      | no       | `ui` and `mono` are font-family lists, max 200 characters, with no `; { } < >` or `\`. `size` is the base UI size in px, an integer from 11 to 18.     |
| `shape`      | no       | `radius` is the base corner radius in px, from 0 to 20. `density` is `compact`, `cozy` or `comfortable`. `sidebarWidth` is an integer from 220 to 420. |
| `background` | no       | Wallpaper. See below.                                                                                                                                  |
| `variants`   | no       | Optional `dark` and `light` palettes. See below. Unknown keys are rejected.                                                                            |
| `css`        | no       | Extra CSS applied after variables. Max 50_000 characters. Defaults to `""`. No `@import`. `url()` only with `data:` or `#`.                            |
| `builtin`    | no       | True for themes shipped with Wooky. Clients cannot overwrite or delete those.                                                                          |

`colors` roles, each an optional hex: `bg0`, `bg1`, `bg2`, `bg3`, `bgHover`, `bgActive`,
`line`, `lineStrong`, `text`, `text2`, `text3`, `text4`, `accent`, `accentInk`, `focus`,
`amber`, `amberBg`, `red`, `redBg`, `green`, `addBg`, `addInk`, `delBg`, `delInk`,
`providerClaude`, `providerCursor`, `providerCodex`, `providerDemo`, `providerOpencode`,
`providerAcp`.

## Variants

Top-level `canvas`, `accent`, `colors` and `background` describe `appearance`. When the
effective colour mode differs and `variants[mode]` exists, that variant replaces those
four fields. Fonts, shape and `css` stay on the theme. If the effective mode differs and
that variant is absent, the top-level fields stay in use.

Effective mode is `colorMode` when it is `dark` or `light`. When `colorMode` is
`system`, it is the operating system mode.

A variant is strict and has:

| Field        | Required | Meaning                                    |
| ------------ | -------- | ------------------------------------------ |
| `canvas`     | yes      | Hex.                                       |
| `accent`     | yes      | Hex.                                       |
| `colors`     | no       | Same roles as the theme. Defaults to `{}`. |
| `background` | no       | Same shape as the theme background.        |

`themes.list` reports `modes`: the theme's `appearance`, then the other mode when that
variant exists. A dark theme with `variants.light` reports `["dark", "light"]`. A dark
theme with only `variants.dark` reports `["dark"]`, because the top-level fields already
describe dark.

## Wallpapers

`background` fields:

| Field            | Required | Meaning                                                                                                                                                                        |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `image`          | no       | Data URL, max 6_000_000 characters. `data:image/png`, `jpeg`, `webp`, `gif`, `avif` or `svg+xml`, then `;base64,` and base64. `javascript:` and `data:text/html` are rejected. |
| `fit`            | no       | `cover`, `contain` or `tile`.                                                                                                                                                  |
| `dim`            | no       | Integer 0–90. Canvas-coloured veil over the image.                                                                                                                             |
| `blur`           | no       | Integer 0–40. Blur of the wallpaper itself, in px.                                                                                                                             |
| `panelBlur`      | no       | Integer 0–40. `backdrop-filter` blur in px on app panels over the wallpaper (frosted glass).                                                                                   |
| `surfaceOpacity` | no       | Integer 0–100. How solid app surfaces are over the image.                                                                                                                      |
| `animated`       | no       | Hint that `image` is an animated SVG. Nothing inspects the bytes.                                                                                                              |

A wallpaper is either a static image or an animated SVG. Animation inside the SVG may be
SMIL or CSS. The document is rendered as an image, so scripts never run. The picture
stays still when `wallpaperMotion` is `off`, when reduced motion is on, or while the
window is hidden.

When `panelBlur` is 8 or less, the conversation pane drops the frost so the picture stays
sharp behind the thread, and only message bodies get a translucent scrim. The sidebar,
composer and menus keep the glass. Higher values frost the whole pane.

`wallpaperMotion` is a device setting, not a theme field. It is `on` or `off` and
defaults to `on`, so the loop is opt-out. It is stored with the other device settings
and comes back from `settings.get`, `settings.put` and `themes.activate`.

`themes.list` sets `hasWallpaper` when the theme or either variant has a background
image, and `animated` when any of those backgrounds sets the hint.

## Importing a t3code theme

`themes.import` takes `{ text, filename?, activate? }`. `text` is at most 7_000_000
characters. `filename`, when present, is at most 255 characters. `activate` asks the
server to make the imported theme the active one.

The result is `{ theme, format }`. `format` is `wooky`, `t3code` or `svg`.

The server classifies `text`:

- Wooky theme JSON, which parses as the theme file above. Format `wooky`.
- A t3code theme JSON. Top-level fields are `version`, `name`, `appearance`,
  `colors` (including `canvas`, `surface` and further keys), optional `variants` and
  optional `css`. Format `t3code`. This object is not an `AppearanceTheme`. It has to
  go through import, which maps it into the Wooky file.
- A raw SVG file. Format `svg`. Import builds a wallpaper theme from it. The SVG is
  stored as a base64 `data:image/svg+xml` image, under the same rules as any other
  wallpaper.

`themes.activate` takes `{ id }` and returns the device settings, with that theme active.

### Colour-role mapping

| t3code                    | Wooky                                               |
| ------------------------- | --------------------------------------------------- |
| `version`                 | not a colour                                        |
| `name`                    | `name`                                              |
| `appearance`              | `appearance`                                        |
| `colors.canvas`           | `canvas`, `bg0`                                     |
| `colors.sidebar`          | `bg1`                                               |
| `colors.surface`          | `bg2`                                               |
| `colors.surfaceRaised`    | `bg3`                                               |
| `colors.sidebarRowHover`  | `bgHover`                                           |
| `colors.sidebarRowActive` | `bgActive`                                          |
| `colors.border`           | `line`                                              |
| `colors.input`            | `lineStrong`                                        |
| `colors.text`             | `text`                                              |
| `colors.textMuted`        | `text2`                                             |
| `colors.placeholder`      | `text3`                                             |
| `colors.iconMuted`        | `text4`                                             |
| `colors.accent`           | `accent`                                            |
| `colors.accentForeground` | `accentInk`                                         |
| `colors.focus`            | `focus`                                             |
| `colors.warning`          | `amber`                                             |
| `colors.warningSurface`   | `amberBg`                                           |
| `colors.error`            | `red`                                               |
| `colors.errorSurface`     | `redBg`                                             |
| `variants.light`          | `variants.light` (same role map on `colors`)        |
| `variants.dark`           | `variants.dark` (same role map on `colors`)         |
| `css`                     | `css` when it passes Wooky rules; otherwise dropped |

## Command line

```
wooky theme set <file>
wooky theme list
wooky theme use <id>
wooky theme off
```

`set` imports a file (Wooky JSON, t3code JSON or SVG) and activates it. `list` prints
installed theme ids, one per line. `use` activates one by id. `off` returns to `default`.
These commands write under `WOOKY_HOME` and do not require a running server; a live server
pushes the change to connected clients.

A theme or settings change made outside the client, including this CLI, is pushed to
connected clients:

```json
{ "push": "themes", "activeThemeId": "paper", "changedIds": ["paper"] }
```

`activeThemeId` is the theme now in use. `changedIds` lists themes whose files changed.

## Stable selectors

Theme `css` may target only the selectors in this list.

- **Page root**: `:root`, `.dark` / `html.dark` (Wooky toggles `dark` on `<html>` when the effective colour mode is dark), `:root:not(.dark)` (light mode), `html[data-theme="dark"]`, `html[data-theme="light"]`, `html[data-wallpaper]` (present when a wallpaper is active).
- **Panels that frost over a wallpaper**: `.sidebar`, `[data-workspace-area="sidebar"]`, `.workspace`, `.composer-box`, `.popover`, `.composer-menu`, `.usage-filter-menu`, `.usage-info-popover`, `.modal`.
- **Sidebar**: `.sidebar`, `[data-workspace-area="sidebar"]`.
- **Thread header**: `.topbar`, `[data-chat-header]`.
- **Main column**: `[data-workspace-area="conversation"]` is the stable wrapper for both an open thread and the new-thread screen. It wraps the thread or draft view with its composer, is not the scroller, and creates an isolated stacking context so a `::before` with `z-index: -1` paints above the wrapper background and below its content.
- **Transcript**: `.thread-scroll`, `.messages-timeline-scroll` (both on the thread scroller), `.prompt`, `[data-user-message-bubble]`, `.md`, `.chat-markdown`, `.code-block`, `.chat-markdown-codeblock`.
- **Composer**: `.composer-col`, `[data-slot="composer-host"]`, `.composer`, `[data-chat-composer-form]` (on the composer form), `.composer-box`. The running-turn stop button is `[data-chat-composer-form] button[aria-label^="Stop"]`.
- **Wallpaper layer**: `.wallpaper`, `[data-wallpaper]`, `.wallpaper-image`, `.wallpaper-tile`, `.wallpaper-veil`.

These are the t3code layout hooks Wooky supports: `[data-workspace-area="sidebar"]`,
`[data-workspace-area="conversation"]`, `[data-chat-header]`, `[data-chat-composer-form]`,
`.messages-timeline-scroll`, and `.dark` on the root with `:root:not(.dark)` for light mode.

### T3-style variable aliases

Defined on `:root` in `apps/web/src/styles/tokens.css` and overridable by theme `css`:

| Alias                  | Maps to                 |
| ---------------------- | ----------------------- |
| `--background`         | `var(--bg-0)`           |
| `--foreground`         | `var(--text)`           |
| `--card`               | `var(--bg-2)`           |
| `--border`             | `var(--line)`           |
| `--primary`            | `var(--accent)`         |
| `--primary-foreground` | `var(--accent-ink)`     |
| `--muted-foreground`   | `var(--text-3)`         |
| `--accent`             | `var(--accent)`         |
| `--font-mono`          | `var(--font-mono)`      |
| `--info`               | `var(--provider-codex)` |
