import { AppstoreOutlined, CloudServerOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { ProCard, ProForm, ProFormSelect, ProFormText, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Tag } from "antd";
import { useEffect, useState } from "react";

type Component = { id: string; version: string; executable: string; checksum: string; installed_at: string; health: string };
type Installation = { id: string; packageId: string; packageVersion: string; runtime: string; status: "installed" | "disabled"; createdAt: string };
type Binding = { id: string; component_id: string; name: string; endpoint: string; installation_id: string | null; created_at: string };

export default function Components() {
  const [components, setComponents] = useState<Component[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const refresh = () => {
    void Promise.all([fetch("/api/components"), fetch("/api/plugins")]).then(async ([componentsResponse, pluginsResponse]) => {
      const componentsData = await componentsResponse.json() as { components?: Component[]; bindings?: Binding[] };
      const pluginsData = await pluginsResponse.json() as { installations?: Installation[] };
      setComponents(componentsData.components ?? []);
      setBindings(componentsData.bindings ?? []);
      setInstallations(pluginsData.installations ?? []);
    });
  };
  useEffect(() => { refresh(); }, []);
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes: [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }] }} location={{ pathname: "/admin/components" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Installed components" style={{ margin: 24 }}><ProTable<Component> rowKey="id" search={false} options={false} dataSource={components} columns={[{ title: "Component", dataIndex: "id" }, { title: "Version", dataIndex: "version" }, { title: "Executable", dataIndex: "executable" }, { title: "Health", dataIndex: "health", render: (value) => <Tag color={value === "healthy" ? "green" : "default"}>{value}</Tag> }]} /></ProCard>
    <ProCard title="Add service binding" style={{ margin: 24 }}><ProForm layout="inline" onFinish={async (values) => { const response = await fetch("/api/service-bindings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); if (!response.ok) { message.error("Unable to create service binding"); return false; } message.success("Service binding created"); refresh(); return true; }}><ProFormSelect name="componentId" label="Component" options={components.map((component) => ({ label: `${component.id} (${component.version})`, value: component.id }))} rules={[{ required: true }]} /><ProFormSelect name="installationId" label="Plugin installation" placeholder="Core global binding" allowClear options={installations.filter((item) => item.status === "installed").map((item) => ({ label: `${item.packageId} (${item.id})`, value: item.id }))} /><ProFormText name="name" label="Name" rules={[{ required: true, max: 80 }]} /><ProFormText name="endpoint" label="HTTP(S) endpoint" placeholder="http://127.0.0.1:5244" rules={[{ required: true, type: "url" }, { max: 2048 }]} /></ProForm></ProCard>
    <ProCard title="Service bindings" style={{ margin: 24 }}><ProTable<Binding> rowKey="id" search={false} options={false} dataSource={bindings} columns={[{ title: "Name", dataIndex: "name" }, { title: "Component", dataIndex: "component_id" }, { title: "Scope", dataIndex: "installation_id", render: (_, row) => row.installation_id === null ? <Tag color="blue">Core global</Tag> : <Tag>{row.installation_id}</Tag> }, { title: "Endpoint", dataIndex: "endpoint" }, { title: "Action", render: (_, row) => <Button danger onClick={async () => { const response = await fetch(`/api/service-bindings/${row.id}`, { method: "DELETE" }); if (!response.ok) { message.error("Unable to revoke service binding"); return; } message.success("Service binding revoked"); refresh(); }}>Revoke</Button> }]} /></ProCard>
  </ProLayout>;
}
