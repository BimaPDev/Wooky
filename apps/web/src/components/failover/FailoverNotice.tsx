import { useState } from "react";
import { useStore } from "../../state/store.ts";
import { noticeText, type FailoverNotice } from "./format.ts";

/** A quiet inline system row: the thread moved to another model, or moved back. */
export function FailoverNoticeRow({ notice }: { notice: FailoverNotice }) {
  const providers = useStore((state) => state.providers);
  const [renderedAt] = useState(() => Date.now());
  return <p className="failover-notice">{noticeText(notice, providers, renderedAt)}</p>;
}
