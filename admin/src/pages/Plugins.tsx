import { AppstoreOutlined, CloudServerOutlined, DeleteOutlined, DownloadOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { ProCard, ProForm, ProFormTextArea, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, Checkbox, message, Popconfirm, Space, Tag } from "antd";
import { useEffect, useState } from "react";

type Installation = { id: string; packageId: string; packageVersion: string; runtime: string; status: "installed" | "disabled" | "uninstalled"; createdAt: string; capabilities?: string[]; declaredCapabilities?: string[]; worker?: { state: "stopped" | "starting" | "running" | "backoff" | "disabled" | "failed"; attempts: number; lastError?: string } };

export default function Plugins() {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const refresh = () => { void fetch("/api/plugins").then((response) => response.json()).then((data) => setInstallations(data.installations ?? [])); };
  const exportData = async (installationId: string, packageId: string) => {
    const response = await fetch(`/api/plugins/${installationId}/data/export`);
    if (!response.ok) { message.error("Unable to export plugin data"); return; }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `carmediahub-${packageId}-data.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    message.success("Plugin data exported");
  };
  const deleteData = async (installationId: string) => {
    const response = await fetch(`/api/plugins/${installationId}/data`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    if (!response.ok) { message.error("Unable to delete plugin data"); return; }
    message.success("Plugin data deleted");
  };
  useEffect(refresh, []);
  const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/plugins", name: "Plugins", icon: <ThunderboltOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/plugins" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Install plugin manifest" style={{ margin: 24 }}><ProForm onFinish={async (values) => { try { const manifest = JSON.parse(String(values.manifest)); const response = await fetch("/api/plugins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) }); if (!response.ok) { message.error("Manifest was rejected"); return false; } message.success("Plugin installation registered"); refresh(); return true; } catch { message.error("Enter valid manifest JSON"); return false; } }}><ProFormTextArea name="manifest" label="Manifest JSON" fieldProps={{ autoSize: { minRows: 6, maxRows: 16 } }} rules={[{ required: true }]} /></ProForm></ProCard>
    <ProCard title="Plugin installations" style={{ margin: 24 }}><ProTable<Installation> rowKey="id" search={false} options={false} dataSource={installations} columns={[{ title: "Package", dataIndex: "packageId" }, { title: "Version", dataIndex: "packageVersion" }, { title: "Runtime", dataIndex: "runtime" }, { title: "Granted capabilities", dataIndex: "capabilities", render: (_, row) => <Checkbox.Group options={row.declaredCapabilities ?? []} value={row.capabilities ?? []} disabled={row.status !== "installed"} onChange={async (value) => { const response = await fetch(`/api/plugins/${row.id}/capabilities`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ capabilities: value }) }); if (!response.ok) { message.error("Unable to update capabilities"); return; } message.success("Capabilities updated"); refresh(); }} /> }, { title: "Installation", dataIndex: "status", render: (value) => <Tag color={value === "installed" ? "green" : value === "uninstalled" ? "red" : "default"}>{value}</Tag> }, { title: "Worker", dataIndex: ["worker", "state"], render: (_, row) => <Tag color={row.worker?.state === "running" ? "green" : row.worker?.state === "failed" ? "red" : "default"}>{row.worker?.state ?? "unknown"}</Tag> }, { title: "Attempts", dataIndex: ["worker", "attempts"] }, { title: "Action", render: (_, row) => <Space><Button icon={<DownloadOutlined />} disabled={row.status === "uninstalled"} onClick={() => void exportData(row.id, row.packageId)}>Export data</Button><Popconfirm title="Delete this plugin's data?" description="This removes records and migration metadata for the current user and installation." onConfirm={() => void deleteData(row.id)} okText="Delete" cancelText="Cancel"><Button danger icon={<DeleteOutlined />} disabled={row.status === "uninstalled"}>Delete data</Button></Popconfirm><Button danger disabled={row.status !== "installed"} onClick={async () => { const response = await fetch(`/api/plugins/${row.id}/disable`, { method: "POST" }); if (!response.ok) { message.error("Unable to disable plugin"); return; } refresh(); }}>Disable</Button><Button disabled={row.status !== "disabled"} onClick={async () => { const response = await fetch(`/api/plugins/${row.id}/enable`, { method: "POST" }); if (!response.ok) { message.error("Unable to enable plugin"); return; } refresh(); }}>Enable</Button><Popconfirm title="Uninstall this plugin?" description="The installation is removed from the active runtime, but plugin data remains until explicitly deleted." onConfirm={async () => { const response = await fetch(`/api/plugins/${row.id}/uninstall`, { method: "POST" }); if (!response.ok) { message.error("Disable the plugin before uninstalling"); return; } refresh(); }} okText="Uninstall" cancelText="Cancel"><Button danger disabled={row.status !== "disabled"}>Uninstall</Button></Popconfirm></Space> }]} /></ProCard>
  </ProLayout>;
}
