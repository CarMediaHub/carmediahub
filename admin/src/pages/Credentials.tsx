import { ProCard, ProForm, ProFormSelect, ProFormText, ProFormTextArea, ProTable } from "@ant-design/pro-components";
import { Button, message, Popconfirm, Tag } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";
import { AdminShell } from "../navigation";

type Credential = { id: string; name: string; kind: "cookie" | "authorization"; organizationId: string; userId: string; installationId: string; createdAt: string; revokedAt: string | null };
type Installation = { id: string; packageId: string; status: "installed" | "disabled" | "uninstalled"; capabilities?: string[] };

export default function Credentials() {
  const { t } = useAdminI18n();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const refresh = () => {
    void Promise.all([fetch("/api/credentials"), fetch("/api/plugins")]).then(async ([credentialResponse, pluginResponse]) => {
      if (credentialResponse.ok) setCredentials(((await credentialResponse.json()) as { credentials?: Credential[] }).credentials ?? []);
      if (pluginResponse.ok) setInstallations(((await pluginResponse.json()) as { installations?: Installation[] }).installations ?? []);
    });
  };
  useEffect(() => { refresh(); }, []);
  const revoke = async (id: string) => {
    const response = await fetch(`/api/credentials/${id}`, { method: "DELETE" });
    if (!response.ok) { message.error(t("common.revokeCredentialFailed")); return; }
    message.success(t("common.credentialRevoked"));
    refresh();
  };
  return <AdminShell pathname="/admin/credentials">
    <ProCard title={t("common.addCredential")} style={{ margin: 24 }}>
      <ProForm onFinish={async (values) => {
        const response = await fetch("/api/credentials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
        if (!response.ok) { message.error(t("common.saveCredentialFailed")); return false; }
        message.success(t("common.credentialSaved"));
        refresh();
        return true;
      }}>
        <ProFormSelect name="installationId" label={t("common.pluginInstallation")} options={installations.filter((item) => item.status === "installed" && item.capabilities?.includes("secrets")).map((item) => ({ label: `${item.packageId} (${item.id})`, value: item.id }))} rules={[{ required: true }]} />
        <ProFormSelect name="kind" label={t("common.credentialType")} options={[{ label: t("common.cookieCredential"), value: "cookie" }, { label: t("common.authorizationCredential"), value: "authorization" }]} rules={[{ required: true }]} />
        <ProFormText name="name" label={t("common.label")} rules={[{ required: true, max: 80 }]} />
        <ProFormTextArea name="value" label={t("common.secretValue")} fieldProps={{ rows: 4 }} rules={[{ required: true, max: 16384 }]} />
      </ProForm>
    </ProCard>
    <ProCard title={t("common.storedCredentials")} style={{ margin: 24 }}>
      <ProTable<Credential> rowKey="id" search={false} options={false} dataSource={credentials} columns={[{ title: t("common.label"), dataIndex: "name" }, { title: t("common.type"), dataIndex: "kind", render: (value) => <Tag>{value}</Tag> }, { title: t("common.pluginInstallation"), dataIndex: "installationId" }, { title: t("common.created"), dataIndex: "createdAt" }, { title: t("common.secretValue"), render: () => <Tag color="green">{t("common.neverDisplayed")}</Tag> }, { title: t("common.action"), render: (_, row) => <Popconfirm title={t("common.revokeCredential")} onConfirm={() => void revoke(row.id)}><Button danger>{t("common.revoke")}</Button></Popconfirm> }]} />
    </ProCard>
  </AdminShell>;
}
