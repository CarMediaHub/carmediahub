import { AppstoreOutlined, CloudServerOutlined, DeleteOutlined, DownloadOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { ProCard, ProForm, ProFormTextArea, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, Checkbox, message, Popconfirm, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";
import { AdminShell } from "../navigation";

type Installation = { id: string; packageId: string; packageVersion: string; runtime: string; status: "installed" | "disabled" | "uninstalled"; createdAt: string; capabilities?: string[]; declaredCapabilities?: string[]; worker?: { state: "stopped" | "starting" | "running" | "backoff" | "disabled" | "failed"; attempts: number; lastError?: string } };

export default function Plugins() {
  const { t } = useAdminI18n();
  const [installations, setInstallations] = useState<Installation[]>([]);
  const refresh = () => { void fetch("/api/plugins").then((response) => response.json()).then((data) => setInstallations(data.installations ?? [])); };
  const exportData = async (installationId: string, packageId: string) => {
    const response = await fetch(`/api/plugins/${installationId}/data/export`);
    if (!response.ok) { message.error(t("plugins.exportFailed")); return; }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `carmediahub-${packageId}-data.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    message.success(t("plugins.exported"));
  };
  const deleteData = async (installationId: string) => {
    const response = await fetch(`/api/plugins/${installationId}/data`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    if (!response.ok) { message.error(t("plugins.deleteFailed")); return; }
    message.success(t("plugins.deleted"));
  };
  useEffect(refresh, []);
  return <AdminShell pathname="/admin/plugins">
    <ProCard title={t("plugins.install")} style={{ margin: 24 }}><ProForm onFinish={async (values) => { try { const manifest = JSON.parse(String(values.manifest)); const response = await fetch("/api/plugins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) }); if (!response.ok) { message.error(t("plugins.manifestRejected")); return false; } message.success(t("plugins.installSuccess")); refresh(); return true; } catch { message.error(t("plugins.invalidJson")); return false; } }}><ProFormTextArea name="manifest" label={t("plugins.manifest")} fieldProps={{ autoSize: { minRows: 6, maxRows: 16 } }} rules={[{ required: true }]} /></ProForm></ProCard>
    <ProCard title={t("plugins.list")} style={{ margin: 24 }}><ProTable<Installation> rowKey="id" search={false} options={false} dataSource={installations} columns={[{ title: t("plugins.package"), dataIndex: "packageId" }, { title: t("overview.version"), dataIndex: "packageVersion" }, { title: t("plugins.runtime"), dataIndex: "runtime" }, { title: t("plugins.capabilities"), dataIndex: "capabilities", render: (_, row) => <Checkbox.Group options={row.declaredCapabilities ?? []} value={row.capabilities ?? []} disabled={row.status !== "installed"} onChange={async (value) => { const response = await fetch(`/api/plugins/${row.id}/capabilities`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ capabilities: value }) }); if (!response.ok) { message.error(t("plugins.capabilityFailed")); return; } message.success(t("plugins.capabilityUpdated")); refresh(); }} /> }, { title: t("plugins.installation"), dataIndex: "status", render: (value) => <Tag color={value === "installed" ? "green" : value === "uninstalled" ? "red" : "default"}>{value}</Tag> }, { title: t("plugins.worker"), dataIndex: ["worker", "state"], render: (_, row) => <Tag color={row.worker?.state === "running" ? "green" : row.worker?.state === "failed" ? "red" : "default"}>{row.worker?.state ?? "unknown"}</Tag> }, { title: t("plugins.attempts"), dataIndex: ["worker", "attempts"] }, { title: t("overview.status"), render: (_, row) => <Space><Button icon={<DownloadOutlined />} disabled={row.status === "uninstalled"} onClick={() => void exportData(row.id, row.packageId)}>{t("plugins.export")}</Button><Popconfirm title={t("plugins.deleteTitle")} description={t("plugins.deleteDescription")} onConfirm={() => void deleteData(row.id)} okText={t("plugins.delete")} cancelText={t("plugins.cancel")}><Button danger icon={<DeleteOutlined />} disabled={row.status === "uninstalled"}>{t("plugins.delete")}</Button></Popconfirm><Button danger disabled={row.status !== "installed"} onClick={async () => { const response = await fetch(`/api/plugins/${row.id}/disable`, { method: "POST" }); if (!response.ok) { message.error(t("plugins.disableFailed")); return; } refresh(); }}>{t("plugins.disable")}</Button><Button disabled={row.status !== "disabled"} onClick={async () => { const response = await fetch(`/api/plugins/${row.id}/enable`, { method: "POST" }); if (!response.ok) { message.error(t("plugins.enableFailed")); return; } refresh(); }}>{t("plugins.enable")}</Button><Popconfirm title={t("plugins.uninstallTitle")} description={t("plugins.uninstallDescription")} onConfirm={async () => { const response = await fetch(`/api/plugins/${row.id}/uninstall`, { method: "POST" }); if (!response.ok) { message.error(t("plugins.disabledBeforeUninstall")); return; } refresh(); }} okText={t("plugins.uninstall")} cancelText={t("plugins.cancel")}><Button danger disabled={row.status !== "disabled"}>{t("plugins.uninstall")}</Button></Popconfirm></Space> }]} /></ProCard>
  </AdminShell>;
}
