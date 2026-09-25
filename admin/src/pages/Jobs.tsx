import { ProCard, ProTable } from "@ant-design/pro-components";
import { Button, message, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";
import { AdminShell } from "../navigation";

type Job = { id: string; type: string; status: string; progress: number; userId: string; installationId: string; createdAt: string; updatedAt: string; completedAt?: string };

export default function Jobs() {
  const { t } = useAdminI18n();
  const statusLabel = (value: string): string => ({ queued: t("common.statusQueued"), running: t("common.statusRunning"), succeeded: t("common.statusSucceeded"), failed: t("common.statusFailed"), cancelled: t("common.statusCancelled"), pending: t("common.statusPending") }[value] ?? t("common.statusUnknown"));
  const [jobs, setJobs] = useState<Job[]>([]);
  const refresh = () => { void fetch("/api/jobs").then((response) => response.ok ? response.json() : { jobs: [] }).then((data) => setJobs(data.jobs ?? [])); };
  useEffect(refresh, []);
  return <AdminShell pathname="/admin/jobs">
    <ProCard title={t("common.tasks")} style={{ margin: 24 }}><ProTable<Job> rowKey="id" search={false} options={{ reload: refresh }} dataSource={jobs} columns={[{ title: t("common.type"), dataIndex: "type" }, { title: t("common.user"), dataIndex: "userId" }, { title: t("common.plugin"), dataIndex: "installationId" }, { title: t("common.progress"), dataIndex: "progress", render: (value) => `${value}%` }, { title: t("common.status"), dataIndex: "status", render: (value) => <Tag color={value === "succeeded" ? "green" : value === "failed" ? "red" : value === "running" ? "blue" : "default"}>{statusLabel(String(value))}</Tag> }, { title: t("common.created"), dataIndex: "createdAt" }, { title: t("common.action"), render: (_, row) => <Space><Button danger disabled={!(["queued", "running"].includes(row.status))} onClick={async () => { const response = await fetch(`/api/jobs/${row.id}/cancel`, { method: "POST" }); if (!response.ok) { message.error(t("common.taskCancelFailed")); return; } message.success(t("common.taskCancelled")); refresh(); }}>{t("common.cancel")}</Button></Space> }]} /></ProCard>
  </AdminShell>;
}
