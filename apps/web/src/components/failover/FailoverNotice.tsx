import type { TurnOrigin } from "@age/contracts";
import { useState } from "react";
import { useStore } from "../../state/store.ts";
import { noticeText } from "./format.ts";

/** A quiet inline system row: the thread moved to another model, or moved back. */
export function FailoverNoticeRow({ origin }: { origin: TurnOrigin }) {
  const providers = useStore((state) => state.providers);
  const [renderedAt] = useState(() => Date.now());
  return <p className="failover-notice">{noticeText(origin, providers, renderedAt)}</p>;
}
