import type { ReactNode } from "react";
import {
  IconBolt,
  IconBot,
  IconBranch,
  IconChart,
  IconCommand,
  IconFolder,
  IconSearch,
  IconSparkles,
  IconTask,
  IconWeb,
} from "../Icons.tsx";

export const SCRIPT_ICONS = [
  "command",
  "web",
  "search",
  "task",
  "bolt",
  "sparkles",
  "folder",
  "bot",
  "chart",
  "branch",
] as const;

export type ScriptIconName = (typeof SCRIPT_ICONS)[number];

export function ScriptIcon({ name }: { name?: string }): ReactNode {
  switch (name) {
    case "web":
      return <IconWeb />;
    case "search":
      return <IconSearch />;
    case "task":
      return <IconTask />;
    case "bolt":
      return <IconBolt />;
    case "sparkles":
      return <IconSparkles />;
    case "folder":
      return <IconFolder />;
    case "bot":
      return <IconBot />;
    case "chart":
      return <IconChart />;
    case "branch":
      return <IconBranch />;
    default:
      return <IconCommand />;
  }
}
