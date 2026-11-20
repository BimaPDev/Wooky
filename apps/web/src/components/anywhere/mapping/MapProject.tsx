import type { Project, SyncPeerProject } from "@wooky/contracts";
import { useMemo, useState } from "react";
import { useStore } from "../../../state/store.ts";
import { addFolderAndMap, mapPeerProject, suggestionReason } from "./mapping.ts";

/** This machine's own projects, scratch space excluded. */
export function useLocalProjects(): Project[] {
  const projects = useStore((state) => state.model.projects);
  return useMemo(
    () => Object.values(projects).filter((project) => project.scratch !== true),
    [projects],
  );
}

/**
 * The ways to say which local project a peer's project is: one click for the suggestion, any
 * local project from the list, or a folder chosen on this machine. Nothing here takes a path from
 * the peer.
 */
export function MapProject({ project }: { project: SyncPeerProject }) {
  const locals = useLocalProjects();
  const [busy, setBusy] = useState(false);
  const suggested = project.suggestion
    ? locals.find((local) => local.id === project.suggestion?.projectId)
    : undefined;

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="map-project">
      {suggested && project.suggestion ? (
        <button
          type="button"
          className="button primary"
          disabled={busy}
          title={`${suggested.root} (${suggestionReason(project.suggestion.by)})`}
          onClick={() => void run(() => mapPeerProject(project.sharedId, suggested.id))}
        >
          Use {suggested.name}
        </button>
      ) : null}
      {suggested && project.suggestion ? (
        <span className="muted map-reason">{suggestionReason(project.suggestion.by)}</span>
      ) : null}
      {locals.length > 0 ? (
        <select
          className="map-select"
          aria-label={`Local project for ${project.name || project.folder}`}
          disabled={busy}
          value=""
          onChange={(event) => {
            const id = event.target.value;
            if (id) void run(() => mapPeerProject(project.sharedId, id));
          }}
        >
          <option value="">Choose a local project…</option>
          {locals.map((local) => (
            <option key={local.id} value={local.id}>
              {local.name}
            </option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        className="button"
        disabled={busy}
        onClick={() => void run(() => addFolderAndMap(project.sharedId))}
      >
        Add this project…
      </button>
    </span>
  );
}
