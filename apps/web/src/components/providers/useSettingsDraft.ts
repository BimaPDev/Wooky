import type { DeviceSettings } from "@wooky/contracts";
import { useEffect, useState } from "react";
import { refreshProviders } from "../../state/actions.ts";
import { patchDeviceSettings } from "../../state/appearance.ts";
import { useStore } from "../../state/store.ts";
import { createSaver } from "../failover/saver.ts";

type Key = "providers" | "acpAgents";

/**
 * One whole-value setting that the Providers page edits. `settings.put` replaces the key, so
 * every save sends the full value; edits are debounced and sent one at a time. After a save the
 * provider list is probed again, so statuses and model lists show the new settings. `busy` is
 * true from the first edit until that probe has returned.
 */
export function useSettingsDraft<K extends Key>(key: K, failure: string) {
  const saved = useStore((state) => state.deviceSettings?.[key]);
  const [draft, setDraft] = useState<DeviceSettings[K] | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushes] = useState(() => {
    let count = 0;
    return { next: () => (count += 1), current: () => count };
  });
  const [saver] = useState(() =>
    createSaver<DeviceSettings[K]>({
      delayMs: 400,
      send: (value) => patchDeviceSettings({ [key]: value } as Partial<DeviceSettings>),
      onIdle: (outcome) => {
        const mine = pushes.current();
        const finish = () => {
          if (pushes.current() !== mine) return;
          setDraft(null);
          setBusy(false);
        };
        if (outcome === "failed") {
          useStore.setState({ notice: failure });
          finish();
        } else {
          void refreshProviders().finally(finish);
        }
      },
    }),
  );

  // sync: send an unsent edit when the page closes
  useEffect(() => () => saver.flush(), [saver]);

  const save = (next: DeviceSettings[K]) => {
    pushes.next();
    setDraft(next);
    setBusy(true);
    saver.push(next);
  };

  return { value: draft ?? saved, save, busy };
}
