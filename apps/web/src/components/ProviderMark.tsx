import type { ProviderKind } from "@age/contracts";
import type { ReactNode } from "react";

const GLYPHS: Record<ProviderKind, ReactNode> = {
  claude: (
    <path d="M8 1.6v12.8M1.6 8h12.8M3.5 3.5l9 9M12.5 3.5l-9 9" strokeWidth="1.5" fill="none" />
  ),
  cursor: <path d="M3.2 2.2l9.6 4.9-4.1 1.5-1.5 4.2z" strokeWidth="1.3" fill="currentColor" />,
  codex: (
    <>
      <path d="M8 1.6l5.5 3.2v6.4L8 14.4l-5.5-3.2V4.8z" strokeWidth="1.3" fill="none" />
      <path d="M6.3 6.4L8 8l-1.7 1.6M9 9.8h1.9" strokeWidth="1.3" fill="none" />
    </>
  ),
  opencode: <path d="M5.6 3H3.4v10h2.2M10.4 3h2.2v10h-2.2M8 8h.01" strokeWidth="1.5" fill="none" />,
  acp: (
    <>
      <circle cx="3.9" cy="8" r="1.9" strokeWidth="1.3" fill="none" />
      <circle cx="12.1" cy="8" r="1.9" strokeWidth="1.3" fill="none" />
      <path d="M5.8 8h4.4" strokeWidth="1.3" fill="none" />
    </>
  ),
  demo: <path d="M5 3.2v9.6l7.6-4.8z" strokeWidth="1.3" fill="none" />,
};

/** A small own-drawn glyph for a provider. Decorative: pair it with the provider's name in text. */
export function ProviderMark({ kind, size = 14 }: { kind: ProviderKind; size?: number }) {
  return (
    <svg
      className={`provider-glyph provider-glyph-${kind}`}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPHS[kind]}
    </svg>
  );
}
