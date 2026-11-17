import { toggleSidebar } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { IconSidebar } from "./Icons.tsx";
import { ProjectMonogram } from "./ProjectMonogram.tsx";

/** T3-style Windows title strip: app brand left, `monogram Project / Thread` center. */
export function WindowTitlebar() {
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const thread = useStore((state) =>
    state.selectedThreadId ? state.model.threads[state.selectedThreadId] : undefined,
  );
  const project = useStore((state) =>
    thread ? state.model.projects[thread.projectId] : undefined,
  );

  return (
    <div className="window-titlebar">
      <div className="window-titlebar-start">
        <button
          type="button"
          className="icon-button"
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          onClick={toggleSidebar}
        >
          <IconSidebar />
        </button>
        <span className="brand">Wooky</span>
      </div>
      <div className="window-titlebar-center" aria-hidden="true">
        {project && thread ? (
          <>
            <ProjectMonogram name={project.name} className="window-titlebar-mark" />
            <span className="window-titlebar-label">
              <span className="window-titlebar-project">{project.name}</span>
              <span className="crumb-sep">/</span>
              <span className="window-titlebar-thread">{thread.title || "Untitled thread"}</span>
            </span>
          </>
        ) : (
          <span className="window-titlebar-label">Wooky</span>
        )}
      </div>
      <div className="window-titlebar-end" />
    </div>
  );
}
