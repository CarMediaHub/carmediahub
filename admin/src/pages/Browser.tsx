import { ProCard, ProTable } from "@ant-design/pro-components";
import { Button, message, Popconfirm, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { adminStatusLabel, useAdminI18n } from "../i18n";
import { AdminShell } from "../navigation";

type BrowserSession = { id: string; name: string; purpose: string; status: string; expiresAt: string; userId: string; installationId: string };
type BrowserTask = { id: string; sessionId: string; kind: string; status: string; createdAt: string; updatedAt: string; userId: string; installationId: string };

export default function Browser() {
  const { t } = useAdminI18n();
  const statusLabel = (value: string): string => adminStatusLabel(t, value);
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [tasks, setTasks] = useState<BrowserTask[]>([]);
  const refresh = () => { void Promise.all([fetch("/api/browser/sessions"), fetch("/api/browser/tasks")]).then(async ([sessionResponse, taskResponse]) => { const sessionData = sessionResponse.ok ? await sessionResponse.json() : { sessions: [] }; const taskData = taskResponse.ok ? await taskResponse.json() : { tasks: [] }; setSessions(sessionData.sessions ?? []); setTasks(taskData.tasks ?? []); }); };
  useEffect(refresh, []);
  return <AdminShell pathname="/admin/browser">
    <ProCard title={t("common.browserSessions")} style={{ margin: 24 }}><ProTable<BrowserSession> rowKey="id" search={false} options={{ reload: refresh }} dataSource={sessions} columns={[{ title: t("common.name"), dataIndex: "name" }, { title: t("common.purpose"), dataIndex: "purpose" }, { title: t("common.user"), dataIndex: "userId" }, { title: t("common.plugin"), dataIndex: "installationId" }, { title: t("common.status"), dataIndex: "status", render: (value) => <Tag color={value === "active" ? "green" : "default"}>{statusLabel(String(value))}</Tag> }, { title: t("common.expires"), dataIndex: "expiresAt" }, { title: t("common.action"), render: (_, row) => <Popconfirm title={t("common.revokeBrowserSession")} onConfirm={async () => { const response = await fetch(`/api/browser/sessions/${row.id}/revoke`, { method: "POST" }); if (!response.ok) { message.error(t("common.revokeSessionFailed")); return; } message.success(t("common.sessionRevoked")); refresh(); }}><Button danger disabled={row.status !== "active"}>{t("common.revoke")}</Button></Popconfirm> }]} /></ProCard>
    <ProCard title={t("common.browserTasks")} style={{ margin: 24 }}><ProTable<BrowserTask> rowKey="id" search={false} options={false} dataSource={tasks} columns={[{ title: t("common.kind"), dataIndex: "kind" }, { title: t("common.session"), dataIndex: "sessionId" }, { title: t("common.user"), dataIndex: "userId" }, { title: t("common.plugin"), dataIndex: "installationId" }, { title: t("common.status"), dataIndex: "status", render: (value) => <Tag color={value === "running" ? "blue" : value === "failed" ? "red" : value === "succeeded" ? "green" : "default"}>{statusLabel(String(value))}</Tag> }, { title: t("common.created"), dataIndex: "createdAt" }, { title: t("common.action"), render: (_, row) => <Space><Button danger disabled={!(row.status === "queued" || row.status === "running")} onClick={async () => { const response = await fetch(`/api/browser/tasks/${row.id}/cancel`, { method: "POST" }); if (!response.ok) { message.error(t("common.cancelTaskFailed")); return; } message.success(t("common.taskCancelled")); refresh(); }}>{t("common.cancel")}</Button></Space> }]} /></ProCard>
  </AdminShell>;
}
