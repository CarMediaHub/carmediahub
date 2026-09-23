import { AppstoreOutlined, CloudServerOutlined, KeyOutlined, LockOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { ProCard, ProForm, ProFormSelect, ProFormText, ProFormTextArea, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Popconfirm, Tag } from "antd";
import { useEffect, useState } from "react";

type Credential = { id: string; name: string; kind: "cookie" | "authorization"; organizationId: string; userId: string; installationId: string; createdAt: string; revokedAt: string | null };
type Installation = { id: string; packageId: string; status: "installed" | "disabled" | "uninstalled"; capabilities?: string[] };

const routes = [
  { path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> },
  { path: "/admin/plugins", name: "Plugins", icon: <CloudServerOutlined /> },
  { path: "/admin/credentials", name: "Credentials", icon: <LockOutlined /> },
  { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> },
  { path: "/admin/media", name: "Media roots", icon: <CloudServerOutlined /> },
  { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> },
  { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> },
  { path: "/admin/users", name: "Users", icon: <TeamOutlined /> },
];

export default function Credentials() {
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
    if (!response.ok) { message.error("Unable to revoke credential"); return; }
    message.success("Credential revoked");
    refresh();
  };
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/credentials" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Add Core-owned credential" style={{ margin: 24 }}>
      <ProForm onFinish={async (values) => {
        const response = await fetch("/api/credentials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
        if (!response.ok) { message.error("Unable to save credential"); return false; }
        message.success("Credential saved without exposing its value");
        refresh();
        return true;
      }}>
        <ProFormSelect name="installationId" label="Plugin installation" options={installations.filter((item) => item.status === "installed" && item.capabilities?.includes("secrets")).map((item) => ({ label: `${item.packageId} (${item.id})`, value: item.id }))} rules={[{ required: true }]} />
        <ProFormSelect name="kind" label="Credential type" options={[{ label: "Cookie", value: "cookie" }, { label: "Authorization", value: "authorization" }]} rules={[{ required: true }]} />
        <ProFormText name="name" label="Label" rules={[{ required: true, max: 80 }]} />
        <ProFormTextArea name="value" label="Secret value" fieldProps={{ rows: 4 }} rules={[{ required: true, max: 16384 }]} />
      </ProForm>
    </ProCard>
    <ProCard title="Stored credentials" style={{ margin: 24 }}>
      <ProTable<Credential> rowKey="id" search={false} options={false} dataSource={credentials} columns={[{ title: "Label", dataIndex: "name" }, { title: "Type", dataIndex: "kind", render: (value) => <Tag>{value}</Tag> }, { title: "Installation", dataIndex: "installationId" }, { title: "Created", dataIndex: "createdAt" }, { title: "Value", render: () => <Tag color="green">Never displayed</Tag> }, { title: "Action", render: (_, row) => <Popconfirm title="Revoke this credential?" onConfirm={() => void revoke(row.id)}><Button danger>Revoke</Button></Popconfirm> }]} />
    </ProCard>
  </ProLayout>;
}
