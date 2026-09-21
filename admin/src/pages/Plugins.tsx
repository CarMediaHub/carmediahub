import { AppstoreOutlined, CloudServerOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { ProCard, ProForm, ProFormTextArea, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Space, Tag } from "antd";
import { useEffect, useState } from "react";

type Installation = { id: string; packageId: string; packageVersion: string; runtime: string; status: "installed" | "disabled"; createdAt: string };

export default function Plugins() {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const refresh = () => { void fetch("/api/plugins").then((response) => response.json()).then((data) => setInstallations(data.installations ?? [])); };
  useEffect(refresh, []);
  const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/plugins", name: "Plugins", icon: <ThunderboltOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/plugins" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Install plugin manifest" style={{ margin: 24 }}><ProForm onFinish={async (values) => { try { const manifest = JSON.parse(String(values.manifest)); const response = await fetch("/api/plugins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) }); if (!response.ok) { message.error("Manifest was rejected"); return false; } message.success("Plugin installation registered"); refresh(); return true; } catch { message.error("Enter valid manifest JSON"); return false; } }}><ProFormTextArea name="manifest" label="Manifest JSON" fieldProps={{ autoSize: { minRows: 6, maxRows: 16 } }} rules={[{ required: true }]} /></ProForm></ProCard>
    <ProCard title="Plugin installations" style={{ margin: 24 }}><ProTable<Installation> rowKey="id" search={false} options={false} dataSource={installations} columns={[{ title: "Package", dataIndex: "packageId" }, { title: "Version", dataIndex: "packageVersion" }, { title: "Runtime", dataIndex: "runtime" }, { title: "Status", dataIndex: "status", render: (value) => <Tag color={value === "installed" ? "green" : "default"}>{value}</Tag> }, { title: "Action", render: (_, row) => <Space><Button danger disabled={row.status !== "installed"} onClick={async () => { const response = await fetch(`/api/plugins/${row.id}/disable`, { method: "POST" }); if (!response.ok) { message.error("Unable to disable plugin"); return; } refresh(); }}>Disable</Button></Space> }]} /></ProCard>
  </ProLayout>;
}
