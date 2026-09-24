import { AppstoreOutlined, CloudServerOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { ProCard, ProForm, ProFormDateTimePicker, ProFormSelect, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";
import { localizeAdminRoutes } from "../navigation";

type Application = { id: string; name: string; route: string };
type EntryKey = { id: string; applicationId: string; applicationName: string; route: string; expiresAt: string | null; revokedAt: string | null; createdAt: string };
const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];

export default function Keys() {
  const { t } = useAdminI18n();
  const [applications, setApplications] = useState<Application[]>([]);
  const [keys, setKeys] = useState<EntryKey[]>([]);
  const refresh = () => { void Promise.all([fetch("/api/apps").then((response) => response.json()), fetch("/api/keys").then((response) => response.json())]).then(([apps, entries]) => { setApplications(apps.applications ?? []); setKeys(entries.keys ?? []); }); };
  useEffect(refresh, []);
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes: localizeAdminRoutes(routes, t) }} location={{ pathname: "/admin/keys" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>{t("nav.signOut")}</Button>]}> 
    <ProCard title={t("common.createEntryKey")} style={{ margin: 24 }}><ProForm layout="inline" onFinish={async (values) => { const response = await fetch("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); const result = await response.json(); if (!response.ok) { message.error(t("common.createKeyFailed")); return false; } await navigator.clipboard?.writeText(`${window.location.origin}/k/${result.key}`); message.success(t("common.keyCreated")); refresh(); return true; }}><ProFormSelect name="applicationId" label={t("common.application")} options={applications.map((app) => ({ label: `${app.name} (${app.route})`, value: app.id }))} rules={[{ required: true }]} /><ProFormDateTimePicker name="expiresAt" label={t("common.expires")} /></ProForm></ProCard>
    <ProCard title={t("common.issuedKeys")} style={{ margin: 24 }}><ProTable<EntryKey> rowKey="id" search={false} options={false} dataSource={keys} columns={[{ title: t("common.application"), dataIndex: "applicationName" }, { title: t("common.route"), dataIndex: "route" }, { title: t("common.created"), dataIndex: "createdAt" }, { title: t("common.expires"), dataIndex: "expiresAt", render: (value) => value ?? t("common.never") }, { title: t("common.status"), render: (_, row) => row.revokedAt ? <Tag color="red">{t("common.revokedStatus")}</Tag> : <Tag color="green">{t("common.activeStatus")}</Tag> }, { title: t("common.action"), render: (_, row) => <Space><Button disabled={Boolean(row.revokedAt)} onClick={async () => { await fetch(`/api/keys/${row.id}/revoke`, { method: "POST" }); refresh(); }}>{t("common.revoke")}</Button></Space> }]} /></ProCard>
  </ProLayout>;
}
