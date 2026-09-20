import { AppstoreOutlined, CloudServerOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, Tag } from "antd";
import { useEffect, useState } from "react";

type Component = { id: string; version: string; executable: string; checksum: string; installed_at: string; health: string };
type Binding = { id: string; component_id: string; name: string; endpoint: string; created_at: string };

export default function Components() {
  const [components, setComponents] = useState<Component[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  useEffect(() => { void fetch("/api/components").then((response) => response.json()).then((data) => { setComponents(data.components ?? []); setBindings(data.bindings ?? []); }); }, []);
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes: [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }] }} location={{ pathname: "/admin/components" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Installed components" style={{ margin: 24 }}><ProTable<Component> rowKey="id" search={false} options={false} dataSource={components} columns={[{ title: "Component", dataIndex: "id" }, { title: "Version", dataIndex: "version" }, { title: "Executable", dataIndex: "executable" }, { title: "Health", dataIndex: "health", render: (value) => <Tag color={value === "healthy" ? "green" : "default"}>{value}</Tag> }]} /></ProCard>
    <ProCard title="Service bindings" style={{ margin: 24 }}><ProTable<Binding> rowKey="id" search={false} options={false} dataSource={bindings} columns={[{ title: "Name", dataIndex: "name" }, { title: "Component", dataIndex: "component_id" }, { title: "Endpoint", dataIndex: "endpoint" }]} /></ProCard>
  </ProLayout>;
}
