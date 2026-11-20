import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SyncConflict } from "@wooky/contracts";
import { z } from "zod";

/** Open conflicts, persisted in WOOKY_HOME/sync/conflicts.json. */
export function createConflictStore(home: string) {
  const file = join(home, "sync", "conflicts.json");
  let open: SyncConflict[] = load();

  function load(): SyncConflict[] {
    try {
      return z.array(SyncConflict).parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return [];
    }
  }

  function save() {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(open, null, 2));
    renameSync(tmp, file);
  }

  return {
    list: (): SyncConflict[] => open.map((conflict) => ({ ...conflict })),
    get: (id: string) => open.find((conflict) => conflict.id === id),
    forPeer: (projectId: string, peerDeviceId: string) =>
      open.find((c) => c.projectId === projectId && c.peerDeviceId === peerDeviceId),
    add(conflict: SyncConflict) {
      open = [...open, conflict];
      save();
    },
    remove(id: string) {
      open = open.filter((conflict) => conflict.id !== id);
      save();
    },
    /** Retention rewrites snapshot ids; conflicts keep pointing at their backups. */
    remap(map: ReadonlyMap<string, string>) {
      let changed = false;
      open = open.map((conflict) => {
        const mine = map.get(conflict.mine);
        if (!mine) return conflict;
        changed = true;
        return { ...conflict, mine };
      });
      if (changed) save();
    },
  };
}
