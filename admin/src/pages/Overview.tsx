import { AppstoreOutlined, CloudServerOutlined, DashboardOutlined, FolderOpenOutlined, HistoryOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, Space, Statistic, Tag } from "antd";
import { useEffect, useState } from "react";

type Application = { id: string; name: string; category: string; route: string; vehicleSupported: boolean };
type Component = { id: string; displayName: string; kind: string; version: string; status: string; executablePath: string };

export default function Overview() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [components, setComponents] = useState<Component[]>([]);
  useEffect(() => { void Promise.all([fetch("/api/apps").then((response) => response.json()), fetch("/api/components/catalog").then((response) => response.ok ? response.json() : { components: [] })]).then(([apps, managed]) => { setApplications(apps.applications ?? []); setComponents(managed.components ?? []); }); }, []);
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes: [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/plugins", name: "Plugins", icon: <ThunderboltOutlined /> }, { path: "/admin/jobs", name: "Tasks", icon: <HistoryOutlined /> }, { path: "/admin/history", name: "History", icon: <HistoryOutlined /> }, { path: "/admin/catalog", name: "Catalog", icon: <AppstoreOutlined /> }, { path: "/admin/speed", name: "Speed test", icon: <DashboardOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }] }} location={{ pathname: "/admin/overview" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}>
    <Space direction="vertical" size="large" style={{ width: "100%", padding: 24 }}>
      <ProCard split="vertical"><Statistic title="Applications" value={applications.length} /><Statistic title="Managed components" value={components.length} /><Statistic title="Gateway" value="Healthy" /></ProCard>
      <ProCard title="Applications"><ProTable<Application> rowKey="id" search={false} options={false} dataSource={applications} columns={[{ title: "Name", dataIndex: "name" }, { title: "Category", dataIndex: "category" }, { title: "Route", dataIndex: "route" }, { title: "Vehicle", dataIndex: "vehicleSupported", render: (_, row) => row.vehicleSupported ? <Tag color="green">Supported</Tag> : <Tag>Desktop</Tag> }]} /></ProCard>
      <ProCard title="Managed component catalog"><ProTable<Component> rowKey="id" search={false} options={false} dataSource={components} columns={[{ title: "Component", dataIndex: "displayName" }, { title: "Kind", dataIndex: "kind" }, { title: "Version", dataIndex: "version" }, { title: "Status", dataIndex: "status" }, { title: "Path", dataIndex: "executablePath" }]} /></ProCard>
    </Space>
  </ProLayout>;
}
