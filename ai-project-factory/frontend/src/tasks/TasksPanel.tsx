import { lazy, Suspense, useState } from "react";
import { Drawer, Spin } from "antd";
import AgentRunsPanel from "./AgentRunsPanel";

const LegacyTasksPanel = lazy(() => import("./LegacyTasksPanel"));

export default function TasksPanel(props: {
  projectId: string;
  onSources?: () => void;
  launchEmployee?: { employee?: string; nonce: number };
}) {
  const [legacyId, setLegacyId] = useState<string>();
  return (
    <>
      <AgentRunsPanel
        key={props.projectId}
        projectId={props.projectId}
        launchEmployee={props.launchEmployee}
        onLegacy={setLegacyId}
      />
      <Drawer
        title="历史任务"
        width="95vw"
        open={!!legacyId}
        onClose={() => setLegacyId(undefined)}
      >
        {legacyId && (
          <Suspense fallback={<Spin />}>
            <LegacyTasksPanel
              key={legacyId}
              {...props}
              initialTask={legacyId}
            />
          </Suspense>
        )}
      </Drawer>
    </>
  );
}
