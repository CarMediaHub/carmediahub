import { AppstoreOutlined, CloudServerOutlined, FolderOpenOutlined, HistoryOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, Input, Select, Space, Tag } from "antd";
import { useEffect, useState } from "react";

type CatalogEntry = { id: string; pluginId: string; subjectType: string; subjectId: string; title: string; description?: string; category: string; route: string; updatedAt: string };
const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/plugins", name: "Plugins", icon: <ThunderboltOutlined /> }, { path: "/admin/jobs", name: "Tasks", icon: <UnorderedListOutlined /> }, { path: "/admin/history", name: "History", icon: <HistoryOutlined /> }, { path: "/admin/catalog", name: "Catalog", icon: <AppstoreOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];

export default function Catalog() {
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState<string>();
  const refresh = () => { const params = new URLSearchParams({ limit: "500", ...(keyword.trim() === "" ? {} : { keyword: keyword.trim() }), ...(category === undefined ? {} : { category }) }); void fetch(`/api/catalog?${params}`).then((response) => response.ok ? response.json() : { entries: [] }).then((data) => setEntries(data.entries ?? [])); };
  useEffect(() => { refresh(); }, []);
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/catalog" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Unified catalog" extra={<Space><Input allowClear placeholder="Search title or description" value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={refresh} /><Select allowClear placeholder="Category" value={category} onChange={setCategory} options={[...new Set(entries.map((entry) => entry.category))].map((value) => ({ label: value, value }))} /><Button onClick={refresh}>Search</Button></Space>} style={{ margin: 24 }}><ProTable<CatalogEntry> rowKey="id" search={false} options={false} dataSource={entries} columns={[{ title: "Title", dataIndex: "title" }, { title: "Plugin", dataIndex: "pluginId" }, { title: "Type", dataIndex: "subjectType" }, { title: "Category", dataIndex: "category", render: (value) => <Tag color="blue">{value}</Tag> }, { title: "Route", dataIndex: "route" }, { title: "Updated", dataIndex: "updatedAt" }]} /></ProCard>
  </ProLayout>;
}
