import { lazy, Suspense, useState } from "react";
import { Drawer, Spin } from "antd";
import type { EmployeeConversation } from "./EmployeeTuning";
import AgentRunsPanel from "./AgentRunsPanel";

const LegacyTasksPanel = lazy(() => import("./LegacyTasksPanel"));

export default function TasksPanel(props: {
  projectId: string;
  initialRun?: string;
  onSources?: () => void;
  onEmployeeChat?: (conversation: EmployeeConversation) => void;
  launchEmployee?: { employee?: string; nonce: number };
}) {
  const [legacyId, setLegacyId] = useState<string>();
  return (
    <>
      <AgentRunsPanel
        key={props.projectId}
        projectId={props.projectId}
        initialRun={props.initialRun}
        launchEmployee={props.launchEmployee}
        onLegacy={setLegacyId}
        onEmployeeChat={props.onEmployeeChat}
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
