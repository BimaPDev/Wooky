import type { BrainKind } from "@wooky/contracts";
import type { ReactNode, SVGProps } from "react";

function Svg({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconBrain = () => (
  <Svg>
    <path d="M8 3.5v9" />
    <path d="M8 4a2.5 2.5 0 0 0-4.5 1.5A2.2 2.2 0 0 0 3 9.2 2.4 2.4 0 0 0 5.5 12.5 2 2 0 0 0 8 11.5" />
    <path d="M8 4a2.5 2.5 0 0 1 4.5 1.5A2.2 2.2 0 0 1 13 9.2a2.4 2.4 0 0 1-2.5 3.3A2 2 0 0 1 8 11.5" />
    <path d="M5 7h1.5M9.5 7H11M5.5 9.8H7M9 9.8h1.5" />
  </Svg>
);

export const IconPin = ({ filled = false }: { filled?: boolean }) => (
  <Svg fill={filled ? "currentColor" : "none"}>
    <path d="M5.5 2.5h5l-.8 4.2L11.5 9v1H4.5V9l1.8-2.3z" />
    <path d="M8 10v4" />
  </Svg>
);

export const IconArchive = () => (
  <Svg>
    <rect x="2.5" y="3" width="11" height="2.8" rx="0.8" />
    <path d="M3.5 5.8V12.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.8" />
    <path d="M6.5 8.5h3" />
  </Svg>
);

export const IconInbox = () => (
  <Svg>
    <path d="M3 4.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
    <path d="M3 9.5h3l1 1.5h2l1-1.5h3" />
  </Svg>
);

export function BrainKindIcon({ kind }: { kind: BrainKind }) {
  switch (kind) {
    case "preference":
      return (
        <Svg>
          <circle cx="8" cy="5.5" r="2.2" />
          <path d="M3.5 13c.7-2.2 2.3-3.2 4.5-3.2s3.8 1 4.5 3.2" />
        </Svg>
      );
    case "decision":
      return (
        <Svg>
          <path d="M8 2.5v11M4.5 5.5L8 2.5l3.5 3" />
          <path d="M4.5 10.5h7" />
        </Svg>
      );
    case "convention":
      return (
        <Svg>
          <path d="M3.5 4.5h9M3.5 8h9M3.5 11.5h6" />
        </Svg>
      );
    case "gotcha":
      return (
        <Svg>
          <path d="M8 2.5L13.8 13H2.2z" />
          <path d="M8 6.5v3M8 11.3h.01" />
        </Svg>
      );
    case "lesson":
      return (
        <Svg>
          <path d="M8 2.5a3.5 3.5 0 0 0-2 6.4V11h4V8.9a3.5 3.5 0 0 0-2-6.4z" />
          <path d="M6.5 13h3" />
        </Svg>
      );
    case "playbook":
      return (
        <Svg>
          <path d="M3.5 3.5h9v9h-9z" />
          <path d="M6 6.5h4M6 9.5h3" />
        </Svg>
      );
    case "provider-note":
      return (
        <Svg>
          <rect x="3" y="4.5" width="10" height="8" rx="1.8" />
          <path d="M8 2.5v2M6 8.5h.01M10 8.5h.01" />
        </Svg>
      );
    case "note":
      return (
        <Svg>
          <path d="M4 2.5h5.5L12.5 5.5v8H4z" />
          <path d="M9.5 2.5v3h3" />
        </Svg>
      );
  }
}
