import { AppstoreOutlined, BellOutlined, CloudServerOutlined, DashboardOutlined, FolderOpenOutlined, HistoryOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";
import { localizeAdminRoutes } from "../navigation";

type Notification = { id: string; pluginId: string; severity: string; title: string; body?: string; createdAt: string; readAt?: string };
const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/plugins", name: "Plugins", icon: <ThunderboltOutlined /> }, { path: "/admin/jobs", name: "Tasks", icon: <UnorderedListOutlined /> }, { path: "/admin/history", name: "History", icon: <HistoryOutlined /> }, { path: "/admin/catalog", name: "Catalog", icon: <AppstoreOutlined /> }, { path: "/admin/speed", name: "Speed test", icon: <DashboardOutlined /> }, { path: "/admin/notifications", name: "Notifications", icon: <BellOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];

export default function Notifications() {
  const { t } = useAdminI18n();
  const [items, setItems] = useState<Notification[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const refresh = () => { void fetch(`/api/notifications?limit=500${unreadOnly ? "&unreadOnly=true" : ""}`).then((response) => response.ok ? response.json() : { notifications: [] }).then((data) => setItems(data.notifications ?? [])); };
  useEffect(refresh, [unreadOnly]);
  const markRead = async (id: string) => { const response = await fetch(`/api/notifications/${id}/read`, { method: "POST" }); if (!response.ok) { message.error(t("common.notificationReadFailed")); return; } refresh(); };
  const markAllRead = async () => { const response = await fetch("/api/notifications/read-all", { method: "POST" }); if (!response.ok) { message.error(t("common.notificationsReadFailed")); return; } refresh(); };
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes: localizeAdminRoutes(routes, t) }} location={{ pathname: "/admin/notifications" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>{t("nav.signOut")}</Button>]}> 
    <ProCard title={t("common.notifications")} style={{ margin: 24 }} extra={<Space><Button onClick={() => void markAllRead()}>{t("common.markAllRead")}</Button><Button type={unreadOnly ? "primary" : "default"} onClick={() => setUnreadOnly((value) => !value)}>{unreadOnly ? t("common.showingUnread") : t("common.showUnread")}</Button></Space>}><ProTable<Notification> rowKey="id" search={false} options={{ reload: refresh }} dataSource={items} columns={[{ title: t("common.severity"), dataIndex: "severity", render: (value) => <Tag color={value === "error" ? "red" : value === "warning" ? "orange" : value === "success" ? "green" : "blue"}>{value}</Tag> }, { title: t("common.title"), dataIndex: "title" }, { title: t("common.message"), dataIndex: "body" }, { title: t("common.plugin"), dataIndex: "pluginId" }, { title: t("common.created"), dataIndex: "createdAt" }, { title: t("common.status"), render: (_, row) => row.readAt === undefined ? <Space><Tag>{t("common.unread")}</Tag><Button size="small" onClick={() => void markRead(row.id)}>{t("common.markRead")}</Button></Space> : <Tag>{t("common.read")}</Tag> }]} /></ProCard>
  </ProLayout>;
}
