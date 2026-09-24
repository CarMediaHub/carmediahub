import { AppstoreOutlined, CloudServerOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { ProCard, ProForm, ProFormSelect, ProFormText, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";

type User = { id: string; username: string; role: "admin" | "member"; locale: string; createdAt: string; revokedAt: string | null };

export default function Users() {
  const { t } = useAdminI18n();
  const [users, setUsers] = useState<User[]>([]);
  const refresh = () => { void fetch("/api/users").then((response) => response.json()).then((data) => setUsers(data.users ?? [])); };
  useEffect(refresh, []);
  const routes = [{ path: "/admin/overview", name: t("nav.overview"), icon: <AppstoreOutlined /> }, { path: "/admin/components", name: t("nav.components"), icon: <CloudServerOutlined /> }, { path: "/admin/media", name: t("nav.media"), icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: t("nav.keys"), icon: <KeyOutlined /> }, { path: "/admin/security", name: t("nav.security"), icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: t("nav.users"), icon: <TeamOutlined /> }];
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/users" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>{t("common.signOut")}</Button>]}> 
    <ProCard title={t("common.add")} style={{ margin: 24 }}><ProForm layout="inline" onFinish={async (values) => { const response = await fetch("/api/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); if (!response.ok) { message.error(t("common.userAddFailed")); return false; } message.success(t("common.userAdded")); refresh(); return true; }}><ProFormText name="username" label={t("common.username")} rules={[{ required: true, min: 3 }]} /><ProFormText.Password name="password" label={t("common.temporaryPassword")} rules={[{ required: true, min: 12 }]} /><ProFormSelect name="role" label={t("common.role")} initialValue="member" options={[{ label: t("common.member"), value: "member" }, { label: t("common.administrator"), value: "admin" }]} /></ProForm></ProCard>
    <ProCard title={t("common.organizationUsers")} style={{ margin: 24 }}><ProTable<User> rowKey="id" search={false} options={false} dataSource={users} columns={[{ title: t("common.username"), dataIndex: "username" }, { title: t("common.role"), dataIndex: "role", render: (value) => <Tag color={value === "admin" ? "blue" : "default"}>{value === "admin" ? t("common.administrator") : t("common.member")}</Tag> }, { title: t("common.locale"), dataIndex: "locale" }, { title: t("common.status"), render: (_, row) => row.revokedAt ? <Tag color="red">{t("common.revoked")}</Tag> : <Tag color="green">{t("common.active")}</Tag> }, { title: t("common.action"), render: (_, row) => <Space><Button disabled={Boolean(row.revokedAt)} danger onClick={async () => { const response = await fetch(`/api/users/${row.id}/revoke`, { method: "POST" }); if (!response.ok) { message.error((await response.json()).code === "CMH.USER.LAST_ADMIN" ? t("common.lastAdmin") : t("common.userRevokeFailed")); return; } refresh(); }}>{t("common.revoke")}</Button></Space> }]} /></ProCard>
  </ProLayout>;
}
