import type { Project } from "@age/contracts";
import { useMemo } from "react";
import {
  defaultDraftProject,
  resolveDraft,
  visibleProjects,
  type NewThreadDraft,
} from "../lib/new-thread.ts";
import {
  ensureScratchProject,
  openFanoutDialog,
  patchNewThread,
  pickProjectFolder,
  sendNewThread,
} from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { ComposerForm } from "./Composer.tsx";
import { IconChevron, IconCheckSmall, IconFolder } from "./Icons.tsx";
import { PopoverChip, usePopoverClose } from "./ModelPicker.tsx";
import { ProjectMonogram } from "./ProjectMonogram.tsx";

const NO_PROJECT = "No project";

/** The draft "New thread" screen. Nothing exists on the server until the first send. */
export function NewThreadView() {
  return (
    <div className="draft-view">
      <div className="draft-center">
        <h1 className="draft-heading">What should we work on?</h1>
        <ProjectSelect />
        <DraftComposer />
      </div>
    </div>
  );
}

/** The draft as stored, or the one the screen starts from when nothing was changed yet. */
function useDraft(): NewThreadDraft {
  const stored = useStore((state) => state.newThread);
  const projects = useStore((state) => state.model.projects);
  const lastProject = useStore((state) => state.draftPrefs.projectId);
  return useMemo(
    () =>
      stored ?? {
        projectId: defaultDraftProject(projects, lastProject),
        interactionMode: "default",
        isolate: false,
      },
    [stored, projects, lastProject],
  );
}

function ProjectSelect() {
  const draft = useDraft();
  const projects = useStore((state) => state.model.projects);
  const list = useMemo(() => visibleProjects(projects), [projects]);
  const current = draft.projectId ? projects[draft.projectId] : undefined;
  return (
    <PopoverChip
      className="draft-project"
      label="Project"
      title="Choose where the thread works"
      size="small"
      placement="below"
      align="start"
      panel={<ProjectMenu projects={list} projectId={draft.projectId} />}
    >
      {current ? <ProjectMonogram name={current.name} /> : <IconFolder />}
      <span className="draft-project-name">{current?.name ?? NO_PROJECT}</span>
      <IconChevron open />
    </PopoverChip>
  );
}

function ProjectMenu({
  projects,
  projectId,
}: {
  projects: readonly Project[];
  projectId: string | null;
}) {
  const close = usePopoverClose();
  return (
    <div className="runtime-menu">
      <div role="radiogroup" aria-label="Project">
        {projects.map((project) => (
          <ProjectOption
            key={project.id}
            label={project.name}
            detail={project.root}
            checked={project.id === projectId}
            onPick={() => {
              patchNewThread({ projectId: project.id });
              close();
            }}
          />
        ))}
        <ProjectOption
          label={NO_PROJECT}
          detail="A scratch folder for one-off questions"
          checked={projectId === null}
          onPick={() => {
            patchNewThread({ projectId: null });
            close();
          }}
        />
      </div>
      <button
        type="button"
        className="runtime-option add"
        onClick={() => {
          close();
          void pickProjectFolder();
        }}
      >
        <IconFolder />
        <span className="runtime-option-copy">
          <span className="runtime-option-title">Add project…</span>
        </span>
      </button>
    </div>
  );
}

function ProjectOption({
  label,
  detail,
  checked,
  onPick,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={checked ? "runtime-option active" : "runtime-option"}
      onClick={onPick}
    >
      <span className="runtime-option-copy">
        <span className="runtime-option-title">{label}</span>
        <span className="runtime-option-desc mono">{detail}</span>
      </span>
      {checked ? (
        <span className="runtime-option-check" aria-hidden="true">
          <IconCheckSmall />
        </span>
      ) : null}
    </button>
  );
}

function DraftComposer() {
  const draft = useDraft();
  const providers = useStore((state) => state.providers);
  const deviceSettings = useStore((state) => state.deviceSettings);
  const prefs = useStore((state) => state.draftPrefs);
  const followUp = useStore((state) => state.deviceSettings?.followUp ?? "queue");
  const resolved = useMemo(
    () => resolveDraft(draft, { providers, deviceSettings, prefs }),
    [draft, providers, deviceSettings, prefs],
  );
  return (
    <ComposerForm
      threadId={null}
      className="draft"
      autoFocus
      followUp={followUp}
      status="idle"
      target={{
        provider: resolved.provider ?? providers[0]?.kind ?? "claude",
        model: resolved.model,
        runtimeMode: resolved.runtimeMode,
        interactionMode: resolved.interactionMode,
        effort: resolved.effort,
        isolate: resolved.isolate,
      }}
      onChange={(patch) => patchNewThread(patch)}
      onSend={(prompt) => sendNewThread(prompt)}
      onNewThread={() => undefined}
      onFanout={(getPrompt) => {
        void (async () => {
          const projectId = resolved.projectId ?? (await ensureScratchProject());
          if (projectId)
            openFanoutDialog({ projectId, runtimeMode: resolved.runtimeMode, getPrompt });
        })();
      }}
    />
  );
}
