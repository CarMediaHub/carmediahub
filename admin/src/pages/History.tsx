import { AppstoreOutlined, CloudServerOutlined, DeleteOutlined, FolderOpenOutlined, HistoryOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Popconfirm, Tag } from "antd";
import { useEffect, useState } from "react";

type HistoryEntry = { id: string; pluginId: string; subjectType: string; title: string; category?: string; route: string; visitedAt: string; sourceDevice: string };
const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/plugins", name: "Plugins", icon: <ThunderboltOutlined /> }, { path: "/admin/jobs", name: "Tasks", icon: <UnorderedListOutlined /> }, { path: "/admin/history", name: "History", icon: <HistoryOutlined /> }, { path: "/admin/catalog", name: "Catalog", icon: <AppstoreOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];

export default function History() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const refresh = () => { void fetch("/api/history?limit=500").then((response) => response.ok ? response.json() : { entries: [] }).then((data) => setEntries(data.entries ?? [])); };
  useEffect(refresh, []);
  const clear = async () => { const response = await fetch("/api/history", { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" }); if (!response.ok) { message.error("Unable to clear history"); return; } message.success("History cleared"); refresh(); };
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/history" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Browsing history" extra={<Popconfirm title="Clear all history?" onConfirm={clear}><Button danger icon={<DeleteOutlined />}>Clear</Button></Popconfirm>} style={{ margin: 24 }}><ProTable<HistoryEntry> rowKey="id" search={false} options={{ reload: refresh }} dataSource={entries} columns={[{ title: "Title", dataIndex: "title" }, { title: "Plugin", dataIndex: "pluginId" }, { title: "Category", dataIndex: "category", render: (value) => value === undefined ? <Tag>Uncategorized</Tag> : <Tag color="blue">{value}</Tag> }, { title: "Route", dataIndex: "route" }, { title: "Device", dataIndex: "sourceDevice" }, { title: "Visited", dataIndex: "visitedAt" }]} /></ProCard>
  </ProLayout>;
}
