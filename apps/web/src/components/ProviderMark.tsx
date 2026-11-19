import type { ProviderKind } from "@wooky/contracts";
import type { ReactNode } from "react";

const GLYPHS: Record<ProviderKind, ReactNode> = {
  claude: (
    <path
      d="M12 2.5v6M12 15.5v6M2.5 12h6M15.5 12h6M5.3 5.3l4.2 4.2M14.5 14.5l4.2 4.2M18.7 5.3l-4.2 4.2M9.5 14.5l-4.2 4.2"
      strokeWidth="2.2"
      fill="none"
    />
  ),
  cursor: (
    <>
      <path d="M12 2.8l8.2 4.7v9L12 21.2l-8.2-4.7v-9z" strokeWidth="1.8" fill="none" />
      <path d="M3.8 7.5L12 12.2l8.2-4.7M12 12.2v9" strokeWidth="1.8" fill="none" />
    </>
  ),
  codex: (
    <>
      <ellipse cx="12" cy="12" rx="4.1" ry="9" strokeWidth="1.7" fill="none" />
      <ellipse
        cx="12"
        cy="12"
        rx="4.1"
        ry="9"
        strokeWidth="1.7"
        fill="none"
        transform="rotate(60 12 12)"
      />
      <ellipse
        cx="12"
        cy="12"
        rx="4.1"
        ry="9"
        strokeWidth="1.7"
        fill="none"
        transform="rotate(120 12 12)"
      />
    </>
  ),
  opencode: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" strokeWidth="1.9" fill="none" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1" strokeWidth="0" fill="currentColor" />
    </>
  ),
  acp: (
    <>
      <circle cx="5.5" cy="12" r="2.8" strokeWidth="1.9" fill="none" />
      <circle cx="18.5" cy="12" r="2.8" strokeWidth="1.9" fill="none" />
      <path d="M8.3 12h7.4" strokeWidth="1.9" fill="none" />
    </>
  ),
  demo: <path d="M7 4.5v15l12-7.5z" strokeWidth="1.9" fill="none" />,
};

/** A small own-drawn glyph for a provider. Decorative: pair it with the provider's name in text. */
export function ProviderMark({ kind, size = 14 }: { kind: ProviderKind; size?: number }) {
  return (
    <svg
      className={`provider-glyph provider-glyph-${kind}`}
      viewBox="0 0 24 24"
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
