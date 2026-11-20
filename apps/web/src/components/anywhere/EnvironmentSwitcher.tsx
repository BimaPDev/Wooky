import type { ReactNode } from "react";
import { openSettings } from "../../state/actions.ts";
import {
  LOCAL_ENVIRONMENT_ID,
  probeEnvironments,
  switchEnvironment,
  useDeviceInfo,
  useEnvironments,
  useEnvironmentSession,
  useProbe,
  type ProbeState,
} from "../../state/environments.ts";
import { IconChevron } from "../Icons.tsx";
import { PopoverChip, usePopoverClose } from "../Popover.tsx";
import { unreachableCopy } from "./format.ts";

const PROBE_LABEL: Record<ProbeState, string> = {
  unknown: "Not checked",
  pending: "Checking",
  open: "Reachable",
  offline: "Offline",
};

function Dot({ id }: { id: string }) {
  const probe = useProbe(id);
  return (
    <span
      className={`env-dot env-${probe}`}
      role="img"
      aria-label={PROBE_LABEL[probe]}
      title={PROBE_LABEL[probe]}
    />
  );
}

/** Which Wooky server this client is showing. Hidden until the client knows another machine. */
export function EnvironmentSwitcher() {
  const session = useEnvironmentSession();
  const environments = useEnvironments();
  if (environments.length === 0 && !session.remote) return null;
  return (
    <PopoverChip
      className="env-chip"
      label="Machines"
      title="Switch machine"
      placement="below"
      size="small"
      onOpenChange={(open) => {
        if (open) void probeEnvironments();
      }}
      panel={<SwitcherPanel />}
    >
      <Dot id={session.id} />
      <span className="env-chip-label">{session.label}</span>
      <IconChevron open={false} />
    </PopoverChip>
  );
}

function SwitcherPanel() {
  const session = useEnvironmentSession();
  const environments = useEnvironments();
  const device = useDeviceInfo();
  const close = usePopoverClose();
  return (
    <div className="env-panel">
      <EnvRow
        id={LOCAL_ENVIRONMENT_ID}
        label={device?.name ?? "This Mac"}
        hint="This machine"
        current={session.id === LOCAL_ENVIRONMENT_ID}
        onPick={close}
      />
      {environments.map((environment) => (
        <EnvRow
          key={environment.id}
          id={environment.id}
          label={environment.label}
          hint={environment.connection.kind}
          current={session.id === environment.id}
          onPick={close}
        />
      ))}
      <div className="popover-group">
        <button
          type="button"
          className="popover-row"
          onClick={() => {
            close();
            openSettings("anywhere");
          }}
        >
          <span className="popover-label">Manage machines</span>
        </button>
      </div>
    </div>
  );
}

function EnvRow({
  id,
  label,
  hint,
  current,
  onPick,
}: {
  id: string;
  label: string;
  hint: string;
  current: boolean;
  onPick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      className={current ? "popover-row env-row current" : "popover-row env-row"}
      onClick={() => {
        onPick();
        void switchEnvironment(id);
      }}
    >
      <Dot id={id} />
      <span className="popover-label">{label}</span>
      <span className="popover-hint">{hint}</span>
    </button>
  );
}

/** A thin bar over the workspace while a remote machine cannot be reached. */
export function EnvironmentBanner() {
  const session = useEnvironmentSession();
  if (!session.remote || !session.unreachable) return null;
  return (
    <div className="env-banner" role="status">
      <span>{unreachableCopy(session.label)}</span>
      <button
        type="button"
        className="link-button"
        onClick={() => void switchEnvironment(LOCAL_ENVIRONMENT_ID)}
      >
        Switch back
      </button>
    </div>
  );
}

/** Names the machine in the top bar, so a hidden sidebar does not hide where you are. */
export function EnvironmentTag() {
  const session = useEnvironmentSession();
  if (!session.remote) return null;
  return (
    <span className="env-tag" title={`Connected to ${session.label}`}>
      <Dot id={session.id} />
      {session.label}
    </span>
  );
}
