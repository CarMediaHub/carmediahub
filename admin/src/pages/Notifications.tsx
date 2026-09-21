import { AppstoreOutlined, BellOutlined, CloudServerOutlined, DashboardOutlined, FolderOpenOutlined, HistoryOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Space, Tag } from "antd";
import { useEffect, useState } from "react";

type Notification = { id: string; pluginId: string; severity: string; title: string; body?: string; createdAt: string; readAt?: string };
const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/plugins", name: "Plugins", icon: <ThunderboltOutlined /> }, { path: "/admin/jobs", name: "Tasks", icon: <UnorderedListOutlined /> }, { path: "/admin/history", name: "History", icon: <HistoryOutlined /> }, { path: "/admin/catalog", name: "Catalog", icon: <AppstoreOutlined /> }, { path: "/admin/speed", name: "Speed test", icon: <DashboardOutlined /> }, { path: "/admin/notifications", name: "Notifications", icon: <BellOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];

export default function Notifications() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const refresh = () => { void fetch(`/api/notifications?limit=500${unreadOnly ? "&unreadOnly=true" : ""}`).then((response) => response.ok ? response.json() : { notifications: [] }).then((data) => setItems(data.notifications ?? [])); };
  useEffect(refresh, [unreadOnly]);
  const markRead = async (id: string) => { const response = await fetch(`/api/notifications/${id}/read`, { method: "POST" }); if (!response.ok) { message.error("Unable to mark notification read"); return; } refresh(); };
  const markAllRead = async () => { const response = await fetch("/api/notifications/read-all", { method: "POST" }); if (!response.ok) { message.error("Unable to mark notifications read"); return; } refresh(); };
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/notifications" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Notifications" style={{ margin: 24 }} extra={<Space><Button onClick={() => void markAllRead()}>Mark all read</Button><Button type={unreadOnly ? "primary" : "default"} onClick={() => setUnreadOnly((value) => !value)}>{unreadOnly ? "Showing unread" : "Show unread"}</Button></Space>}><ProTable<Notification> rowKey="id" search={false} options={{ reload: refresh }} dataSource={items} columns={[{ title: "Severity", dataIndex: "severity", render: (value) => <Tag color={value === "error" ? "red" : value === "warning" ? "orange" : value === "success" ? "green" : "blue"}>{value}</Tag> }, { title: "Title", dataIndex: "title" }, { title: "Message", dataIndex: "body" }, { title: "Plugin", dataIndex: "pluginId" }, { title: "Created", dataIndex: "createdAt" }, { title: "Status", render: (_, row) => row.readAt === undefined ? <Space><Tag>Unread</Tag><Button size="small" onClick={() => void markRead(row.id)}>Mark read</Button></Space> : <Tag>Read</Tag> }]} /></ProCard>
  </ProLayout>;
}
