export type MentionMenuFooter = "none" | "searching" | "no-matches";

export function mentionMenuFooter(
  mentionQuery: string | null,
  entriesQuery: string | null,
  itemCount: number,
  searchUnavailable: boolean,
): MentionMenuFooter {
  if (mentionQuery === null || searchUnavailable) return "none";
  if (entriesQuery !== mentionQuery) return "searching";
  if (itemCount === 0) return "no-matches";
  return "none";
}
