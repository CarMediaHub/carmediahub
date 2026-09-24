import { AppstoreOutlined, CloudServerOutlined, DatabaseOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { ProCard, ProForm, ProFormSelect, ProFormText, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Space } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";

type MediaRoot = { id: string; name: string; createdAt: string };
type Installation = { id: string; packageId: string; packageVersion: string; status: string };

export default function Media() {
  const { t } = useAdminI18n();
  const routes = [{ path: "/admin/overview", name: t("nav.overview"), icon: <AppstoreOutlined /> }, { path: "/admin/components", name: t("nav.components"), icon: <CloudServerOutlined /> }, { path: "/admin/media", name: t("nav.media"), icon: <FolderOpenOutlined /> }, { path: "/admin/media-sources", name: t("nav.media"), icon: <DatabaseOutlined /> }, { path: "/admin/keys", name: t("nav.keys"), icon: <KeyOutlined /> }, { path: "/admin/security", name: t("nav.security"), icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: t("nav.users"), icon: <TeamOutlined /> }];
  const [roots, setRoots] = useState<MediaRoot[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const refresh = () => { void fetch("/api/media-roots").then(async (response) => response.ok ? response.json() : { roots: [] }).then((data) => setRoots(data.roots ?? [])); };
  useEffect(() => { refresh(); void fetch("/api/plugins").then((response) => response.ok ? response.json() : { installations: [] }).then((data) => setInstallations(data.installations ?? [])); }, []);
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/media" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>{t("common.signOut")}</Button>]}> 
    <ProCard title={t("common.add")} style={{ margin: 24 }}><ProForm layout="inline" onFinish={async (values) => { const response = await fetch("/api/media-roots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); if (!response.ok) { message.error(t("common.mediaRootAddFailed")); return false; } message.success(t("common.mediaRootAdded")); refresh(); return true; }}><ProFormSelect name="installationId" label={t("common.pluginInstallation")} options={installations.filter((item) => item.status === "installed").map((item) => ({ label: `${item.packageId} (${item.id})`, value: item.id }))} rules={[{ required: true }]} /><ProFormText name="name" label={t("common.name")} rules={[{ required: true, max: 80 }]} /><ProFormText name="path" label={t("common.selectedDirectory")} rules={[{ required: true }]} /></ProForm></ProCard>
    <ProCard title={t("common.mediaRoots")} style={{ margin: 24 }}><ProTable<MediaRoot> rowKey="id" search={false} options={false} dataSource={roots} columns={[{ title: t("common.name"), dataIndex: "name" }, { title: t("common.added"), dataIndex: "createdAt" }, { title: t("common.action"), render: (_, row) => <Space><Button danger onClick={async () => { const response = await fetch(`/api/media-roots/${row.id}/revoke`, { method: "POST" }); if (!response.ok) { message.error(t("common.mediaRootRevokeFailed")); return; } refresh(); }}>{t("common.revoke")}</Button></Space> }]} /></ProCard>
  </ProLayout>;
}
