import { ProCard, ProForm, ProFormSelect, ProFormText, ProFormTextArea, ProTable } from "@ant-design/pro-components";
import { Button, message, Tag } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";
import { AdminShell } from "../navigation";

type Component = { id: string; version: string; executable: string; checksum: string; installed_at: string; health: string };
type CatalogComponent = { id: string; displayName: string; kind: string; version: string; executable: string; platforms: string[]; status: string };
type Installation = { id: string; packageId: string; packageVersion: string; runtime: string; status: "installed" | "disabled" | "uninstalled"; createdAt: string };
type Binding = { id: string; component_id: string; name: string; endpoint: string; installation_id: string | null; created_at: string };
type BindingGrant = { bindingId: string; name: string; scope: "global" | "installation"; installationId: string | null; authorizedInstallations: string[] };

async function validateBindingEndpoint(_rule: unknown, value: string): Promise<void> {
  if (value === undefined || value.trim() === "") return;
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new Error("Enter a valid HTTP(S) endpoint"); }
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "" || endpoint.hostname === "" || (endpoint.port !== "" && (!/^\d+$/u.test(endpoint.port) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535))) throw new Error("Endpoint must be HTTP(S) without credentials, query, or fragment");
}

export default function Components() {
  const { t } = useAdminI18n();
  const [components, setComponents] = useState<Component[]>([]);
  const [catalog, setCatalog] = useState<CatalogComponent[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [bindingGrants, setBindingGrants] = useState<BindingGrant[]>([]);
  const refresh = () => {
    void Promise.all([fetch("/api/components"), fetch("/api/components/catalog"), fetch("/api/plugins")]).then(async ([componentsResponse, catalogResponse, pluginsResponse]) => {
      const componentsData = await componentsResponse.json() as { components?: Component[]; bindings?: Binding[]; bindingGrants?: BindingGrant[] };
      const catalogData = await catalogResponse.json() as { components?: CatalogComponent[] };
      const pluginsData = await pluginsResponse.json() as { installations?: Installation[] };
      setComponents(componentsData.components ?? []);
      setCatalog(catalogData.components ?? []);
      setBindings(componentsData.bindings ?? []);
      setBindingGrants(componentsData.bindingGrants ?? []);
      setInstallations(pluginsData.installations ?? []);
    });
  };
  useEffect(() => { refresh(); }, []);
  const installSignedComponent = async (values: Record<string, unknown>): Promise<boolean> => {
    try {
      const release = JSON.parse(String(values.release)) as unknown;
      const response = await fetch("/api/components/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(release) });
      if (!response.ok) { message.error(t("common.componentInstallRejected")); return false; }
      message.success(t("common.componentInstalled"));
      refresh();
      return true;
    } catch {
      message.error(t("common.invalidComponentReleaseJson"));
      return false;
    }
  };
  return <AdminShell pathname="/admin/components">
    <ProCard title={t("common.components")} style={{ margin: 24 }}><ProTable<Component> rowKey="id" search={false} options={false} dataSource={components} columns={[{ title: t("common.component"), dataIndex: "id" }, { title: t("common.version"), dataIndex: "version" }, { title: t("common.executable"), dataIndex: "executable" }, { title: t("common.health"), dataIndex: "health", render: (value) => <Tag color={value === "healthy" ? "green" : "default"}>{value}</Tag> }, { title: t("common.action"), render: (_, row) => <Button onClick={async () => { const response = await fetch(`/api/components/${row.id}/health`, { method: "POST" }); if (!response.ok) { message.error(t("common.check")); return; } const result = await response.json() as { component: { health: string } }; message.success(`${t("common.component")} ${result.component.health}`); refresh(); }}>{t("common.check")}</Button> }]} /></ProCard>
    <ProCard title={t("common.catalog")} style={{ margin: 24 }}><ProTable<CatalogComponent> rowKey="id" search={false} options={false} dataSource={catalog} columns={[{ title: t("common.component"), dataIndex: "displayName" }, { title: t("common.kind"), dataIndex: "kind" }, { title: t("common.version"), dataIndex: "version" }, { title: t("common.status"), dataIndex: "status", render: (value) => <Tag color={value === "installed" ? "green" : "default"}>{value}</Tag> }, { title: t("common.platforms"), dataIndex: "platforms", render: (_, row) => row.platforms.join(", ") }]} /></ProCard>
    <ProCard title={t("common.installSignedComponent")} style={{ margin: 24 }}><ProForm onFinish={installSignedComponent}><ProFormTextArea name="release" label={t("common.componentRelease")} fieldProps={{ rows: 8 }} rules={[{ required: true }]} /></ProForm></ProCard>
    <ProCard title={t("common.addServiceBinding")} style={{ margin: 24 }}><ProForm layout="inline" onFinish={async (values) => { const response = await fetch("/api/service-bindings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); if (!response.ok) { message.error(t("common.serviceBindingCreateFailed")); return false; } message.success(t("common.serviceBindingCreated")); refresh(); return true; }}><ProFormSelect name="componentId" label={t("common.component")} options={components.map((component) => ({ label: `${component.id} (${component.version})`, value: component.id }))} rules={[{ required: true }]} /><ProFormSelect name="installationId" label={t("common.pluginInstallation")} placeholder={t("common.coreGlobal")} allowClear options={installations.filter((item) => item.status === "installed").map((item) => ({ label: `${item.packageId} (${item.id})`, value: item.id }))} /><ProFormText name="name" label={t("common.name")} rules={[{ required: true, max: 80 }]} /><ProFormText name="endpoint" label={t("common.endpoint")} placeholder="http://127.0.0.1:5244" rules={[{ required: true, validator: validateBindingEndpoint }, { max: 2048 }]} /></ProForm></ProCard>
    <ProCard title={t("common.serviceBindings")} style={{ margin: 24 }}><ProTable<Binding> rowKey="id" search={false} options={false} dataSource={bindings} columns={[{ title: t("common.name"), dataIndex: "name" }, { title: t("common.component"), dataIndex: "component_id" }, { title: t("common.scope"), dataIndex: "installation_id", render: (_, row) => row.installation_id === null ? <Tag color="blue">{t("common.coreGlobal")}</Tag> : <Tag>{row.installation_id}</Tag> }, { title: t("common.authorizedInstallations"), render: (_, row) => { const grant = bindingGrants.find((item) => item.bindingId === row.id); return row.installation_id !== null ? row.installation_id : (grant?.authorizedInstallations.length ? grant.authorizedInstallations.join(", ") : <Tag>{t("common.noneDeclared")}</Tag>); } }, { title: t("common.endpoint"), dataIndex: "endpoint" }, { title: t("common.action"), render: (_, row) => <><Button onClick={async () => { const response = await fetch(`/api/service-bindings/${row.id}/health`, { method: "POST" }); if (!response.ok) { message.error(t("common.serviceBindingUnreachable")); return; } const result = await response.json() as { status: number; latencyMs: number }; message.success(`${t("common.reachable")} (${result.status}) ${result.latencyMs} ms`); }}>{t("common.check")}</Button> <Button danger onClick={async () => { const response = await fetch(`/api/service-bindings/${row.id}`, { method: "DELETE" }); if (!response.ok) { message.error(t("common.serviceBindingRevokeFailed")); return; } message.success(t("common.serviceBindingRevoked")); refresh(); }}>{t("common.revoke")}</Button></> }]} /></ProCard>
  </AdminShell>;
}
