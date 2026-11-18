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
export const IconRefresh = () => (
  <Svg>
    <path d="M3.5 8a4.5 4.5 0 0 1 7.6-3.2L13 3.5V7H9.5" />
    <path d="M12.5 8a4.5 4.5 0 0 1-7.6 3.2L3 12.5V9h3.5" />
  </Svg>
);
export const IconSun = () => (
  <Svg>
    <circle cx="8" cy="8" r="2.5" />
    <path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.8 3.8l1.1 1.1M11.1 11.1l1.1 1.1M12.2 3.8l-1.1 1.1M4.9 11.1l-1.1 1.1" />
  </Svg>
);
export const IconMoon = () => (
  <Svg>
    <path d="M11.5 9.2A4.5 4.5 0 1 1 6.8 4.5 3.6 3.6 0 0 0 11.5 9.2z" />
  </Svg>
);
export const IconPaint = () => (
  <Svg>
    <path d="M3.5 10.5c0 1.4 1.1 2.5 2.5 2.5h.5V11a1.5 1.5 0 0 1 3 0v2h.5c1.4 0 2.5-1.1 2.5-2.5V9H3.5z" />
    <path d="M5 9V4.5A1.5 1.5 0 0 1 6.5 3h3A1.5 1.5 0 0 1 11 4.5V9" />
  </Svg>
);
export const IconChevron = ({ open = false }: { open?: boolean }) => (
  <Svg className={open ? "chevron open" : "chevron"}>
    <path d="M6 4l4 4-4 4" />
  </Svg>
);
export const IconChevronLeft = () => (
  <Svg>
    <path d="M10 3.5L5.5 8 10 12.5" />
  </Svg>
);
export const IconChevronRight = () => (
  <Svg>
    <path d="M6 3.5L10.5 8 6 12.5" />
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
export const IconAlert = () => (
  <Svg>
    <path d="M8 2.5L14 13.5H2z" />
    <path d="M8 6.5v3.5M8 11.5h.01" />
  </Svg>
);
export const IconMic = () => (
  <Svg>
    <rect x="6" y="2.5" width="4" height="7" rx="2" />
    <path d="M4.5 8.5a3.5 3.5 0 007 0M8 12v2" />
  </Svg>
);
export const IconLock = () => (
  <Svg>
    <rect x="3.5" y="7" width="9" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
  </Svg>
);
export const IconPen = () => (
  <Svg>
    <path d="M10.5 2.5l3 3L6 13H3v-3z" />
  </Svg>
);
export const IconShield = () => (
  <Svg>
    <path d="M8 2.5l5 2v3.5c0 3.2-2.1 5.5-5 6.5-2.9-1-5-3.3-5-6.5V4.5z" />
  </Svg>
);
export const IconCheckSmall = () => (
  <Svg>
    <path d="M3.5 8.2l3 3 6-6.5" />
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
export const IconSettings = () => (
  <Svg>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1" />
  </Svg>
);
export const IconSidebar = () => (
  <Svg>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <path d="M6 2.5v11" />
  </Svg>
);
export const IconPanelBottom = () => (
  <Svg>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <path d="M2 10h12" />
  </Svg>
);
export const IconPanelRight = () => (
  <Svg>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <path d="M10 2.5v11" />
  </Svg>
);
export const IconDetails = () => (
  <Svg>
    <rect x="2.5" y="2" width="11" height="12" rx="2" />
    <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
  </Svg>
);
export const IconFolderPlus = () => (
  <Svg>
    <path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1z" />
    <path d="M8 7.5v3.5M6.25 9.25h3.5" />
  </Svg>
);
export const IconCompose = () => (
  <Svg>
    <path d="M13 9v3.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1H7" />
    <path d="M11.5 2l2.5 2.5L8.5 10H6V7.5z" />
  </Svg>
);
export const IconSliders = () => (
  <Svg>
    <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
    <circle cx="10" cy="4.5" r="1.5" />
    <circle cx="6" cy="11.5" r="1.5" />
  </Svg>
);
export const IconPalette = () => (
  <Svg>
    <path d="M8 2a6 6 0 1 0 0 12c1 0 1.5-.6 1.5-1.3 0-.9-.8-1.2-.8-2 0-.7.6-1.2 1.3-1.2H12a2 2 0 0 0 2-2C14 4.5 11.3 2 8 2z" />
    <circle cx="5" cy="7" r=".6" />
    <circle cx="7.5" cy="4.8" r=".6" />
    <circle cx="10.5" cy="5.5" r=".6" />
  </Svg>
);
export const IconChart = () => (
  <Svg>
    <path d="M3 13V8M8 13V3M13 13V6" />
  </Svg>
);
export const IconBot = () => (
  <Svg>
    <rect x="3" y="5" width="10" height="8" rx="2" />
    <path d="M8 2.5V5M6 9h.01M10 9h.01" />
  </Svg>
);
export const IconInfo = () => (
  <Svg>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.5V11M8 5h.01" />
  </Svg>
);
export const IconBranch = () => (
  <Svg>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="5.5" r="1.5" />
    <path d="M4.5 5v6M11.5 7c0 2.5-3 3-7 4" />
  </Svg>
);
/** Lucide GitPullRequestArrow — T3 sidebar footer PR utility. */
export const IconPullRequest = () => (
  <Svg>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <path d="M4.5 5v6" />
    <path d="M11.5 3.5v5.2a2.8 2.8 0 0 1-2.8 2.8H4.5" />
    <path d="M9.2 1.8L11.5 3.5 9.2 5.2" />
  </Svg>
);
export const IconRestore = () => (
  <Svg>
    <path d="M2.5 3v3.5H6" />
    <path d="M3 9.5A5 5 0 1 0 4 4.6L2.5 6.5" />
  </Svg>
);
/** Lucide CircleArrowUp — T3 SidebarUpdatePill "everything" glyph. */
export const IconCircleArrowUp = () => (
  <Svg>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 11.1V5.3M5.5 7.7L8 5.2l2.5 2.5" />
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
