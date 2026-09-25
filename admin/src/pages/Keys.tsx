import { ProCard, ProForm, ProFormDateTimePicker, ProFormSelect, ProTable } from "@ant-design/pro-components";
import { Button, message, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";
import { AdminShell } from "../navigation";

type Application = { id: string; name: string; route: string };
type EntryKey = { id: string; applicationId: string; applicationName: string; route: string; expiresAt: string | null; revokedAt: string | null; createdAt: string };

export default function Keys() {
  const { t } = useAdminI18n();
  const [applications, setApplications] = useState<Application[]>([]);
  const [keys, setKeys] = useState<EntryKey[]>([]);
  const refresh = () => { void Promise.all([fetch("/api/apps").then((response) => response.json()), fetch("/api/keys").then((response) => response.json())]).then(([apps, entries]) => { setApplications(apps.applications ?? []); setKeys(entries.keys ?? []); }); };
  useEffect(refresh, []);
  return <AdminShell pathname="/admin/keys">
    <ProCard title={t("common.createEntryKey")} style={{ margin: 24 }}><ProForm layout="inline" onFinish={async (values) => { const response = await fetch("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); const result = await response.json(); if (!response.ok) { message.error(t("common.createKeyFailed")); return false; } await navigator.clipboard?.writeText(`${window.location.origin}/k/${result.key}`); message.success(t("common.keyCreated")); refresh(); return true; }}><ProFormSelect name="applicationId" label={t("common.application")} options={applications.map((app) => ({ label: `${app.name} (${app.route})`, value: app.id }))} rules={[{ required: true }]} /><ProFormDateTimePicker name="expiresAt" label={t("common.expires")} /></ProForm></ProCard>
    <ProCard title={t("common.issuedKeys")} style={{ margin: 24 }}><ProTable<EntryKey> rowKey="id" search={false} options={false} dataSource={keys} columns={[{ title: t("common.application"), dataIndex: "applicationName" }, { title: t("common.route"), dataIndex: "route" }, { title: t("common.created"), dataIndex: "createdAt" }, { title: t("common.expires"), dataIndex: "expiresAt", render: (value) => value ?? t("common.never") }, { title: t("common.status"), render: (_, row) => row.revokedAt ? <Tag color="red">{t("common.revokedStatus")}</Tag> : <Tag color="green">{t("common.activeStatus")}</Tag> }, { title: t("common.action"), render: (_, row) => <Space><Button disabled={Boolean(row.revokedAt)} onClick={async () => { const response = await fetch(`/api/keys/${row.id}/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresAt: row.expiresAt }) }); if (!response.ok) { message.error(t("common.rotateKeyFailed")); return; } const result = await response.json() as { key: string }; await navigator.clipboard?.writeText(`${window.location.origin}/k/${result.key}`); message.success(t("common.keyRotated")); refresh(); }}>{t("common.rotate")}</Button><Button danger disabled={Boolean(row.revokedAt)} onClick={async () => { await fetch(`/api/keys/${row.id}/revoke`, { method: "POST" }); refresh(); }}>{t("common.revoke")}</Button></Space> }]} /></ProCard>
  </AdminShell>;
}
