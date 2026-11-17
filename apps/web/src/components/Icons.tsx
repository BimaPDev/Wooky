import type { ToolKind } from "@age/contracts";
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

export const IconRead = () => (
  <Svg>
    <path d="M4 2h5l3 3v9H4z" />
    <path d="M9 2v3h3" />
  </Svg>
);
export const IconEdit = () => (
  <Svg>
    <path d="M10.5 2.5l3 3L6 13H3v-3z" />
  </Svg>
);
export const IconCommand = () => (
  <Svg>
    <path d="M3 4l4 4-4 4" />
    <path d="M8.5 12H13" />
  </Svg>
);
export const IconSearch = () => (
  <Svg>
    <circle cx="7" cy="7" r="4" />
    <path d="M10 10l3.5 3.5" />
  </Svg>
);
export const IconWeb = () => (
  <Svg>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M2.5 8h11M8 2.5c2 2.2 2 8.8 0 11M8 2.5c-2 2.2-2 8.8 0 11" />
  </Svg>
);
export const IconTask = () => (
  <Svg>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <path d="M5 6.5h6M5 9.5h4" />
  </Svg>
);
export const IconDot = () => (
  <Svg>
    <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconPlus = () => (
  <Svg>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const IconClose = () => (
  <Svg>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const IconChevron = ({ open = false }: { open?: boolean }) => (
  <Svg className={open ? "chevron open" : "chevron"}>
    <path d="M6 4l4 4-4 4" />
  </Svg>
);
export const IconTrash = () => (
  <Svg>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
  </Svg>
);
export const IconUndo = () => (
  <Svg>
    <path d="M5 4L2.5 6.5 5 9" />
    <path d="M2.5 6.5H10a3.5 3.5 0 010 7H7" />
  </Svg>
);
export const IconCopy = () => (
  <Svg>
    <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
    <path d="M3 10.5V3.5A1 1 0 014 2.5h7" />
  </Svg>
);
export const IconCheck = () => (
  <Svg>
    <path d="M3 8.5l3 3 7-7" />
  </Svg>
);
export const IconStop = () => (
  <Svg>
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconSend = () => (
  <Svg>
    <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
  </Svg>
);
export const IconChanges = () => (
  <Svg>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M8 5v4M6 7h4M6 11h4" />
  </Svg>
);
export const IconFolder = () => (
  <Svg>
    <path d="M2.5 4.5a1 1 0 011-1h3l1.5 1.5h4.5a1 1 0 011 1v6a1 1 0 01-1 1h-9a1 1 0 01-1-1z" />
  </Svg>
);
export const IconFailed = () => (
  <Svg>
    <path d="M5 5l6 6M11 5l-6 6" />
  </Svg>
);

export function ToolIcon({ kind }: { kind: ToolKind }) {
  switch (kind) {
    case "read":
      return <IconRead />;
    case "edit":
      return <IconEdit />;
    case "command":
      return <IconCommand />;
    case "search":
      return <IconSearch />;
    case "web":
      return <IconWeb />;
    case "task":
      return <IconTask />;
    case "other":
      return <IconDot />;
  }
}
