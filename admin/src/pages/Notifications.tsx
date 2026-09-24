import { AppstoreOutlined, BellOutlined, CloudServerOutlined, DashboardOutlined, FolderOpenOutlined, HistoryOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";
import { AdminShell } from "../navigation";

type Notification = { id: string; pluginId: string; severity: string; title: string; body?: string; createdAt: string; readAt?: string };

export default function Notifications() {
  const { t } = useAdminI18n();
  const [items, setItems] = useState<Notification[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const refresh = () => { void fetch(`/api/notifications?limit=500${unreadOnly ? "&unreadOnly=true" : ""}`).then((response) => response.ok ? response.json() : { notifications: [] }).then((data) => setItems(data.notifications ?? [])); };
  useEffect(refresh, [unreadOnly]);
  const markRead = async (id: string) => { const response = await fetch(`/api/notifications/${id}/read`, { method: "POST" }); if (!response.ok) { message.error(t("common.notificationReadFailed")); return; } refresh(); };
  const markAllRead = async () => { const response = await fetch("/api/notifications/read-all", { method: "POST" }); if (!response.ok) { message.error(t("common.notificationsReadFailed")); return; } refresh(); };
  return <AdminShell pathname="/admin/notifications">
    <ProCard title={t("common.notifications")} style={{ margin: 24 }} extra={<Space><Button onClick={() => void markAllRead()}>{t("common.markAllRead")}</Button><Button type={unreadOnly ? "primary" : "default"} onClick={() => setUnreadOnly((value) => !value)}>{unreadOnly ? t("common.showingUnread") : t("common.showUnread")}</Button></Space>}><ProTable<Notification> rowKey="id" search={false} options={{ reload: refresh }} dataSource={items} columns={[{ title: t("common.severity"), dataIndex: "severity", render: (value) => <Tag color={value === "error" ? "red" : value === "warning" ? "orange" : value === "success" ? "green" : "blue"}>{value}</Tag> }, { title: t("common.title"), dataIndex: "title" }, { title: t("common.message"), dataIndex: "body" }, { title: t("common.plugin"), dataIndex: "pluginId" }, { title: t("common.created"), dataIndex: "createdAt" }, { title: t("common.status"), render: (_, row) => row.readAt === undefined ? <Space><Tag>{t("common.unread")}</Tag><Button size="small" onClick={() => void markRead(row.id)}>{t("common.markRead")}</Button></Space> : <Tag>{t("common.read")}</Tag> }]} /></ProCard>
  </AdminShell>;
}
