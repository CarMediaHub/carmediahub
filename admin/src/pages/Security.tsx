import { AppstoreOutlined, CloudServerOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { ProCard, ProForm, ProFormText, ProLayout } from "@ant-design/pro-components";
import { Alert, Button, Descriptions, Modal, Space, Typography, message } from "antd";
import { useEffect, useState } from "react";

type TotpSetup = { secret: string; otpauthUrl: string };

export default function Security() {
  const [enabled, setEnabled] = useState(false);
  const [setup, setSetup] = useState<TotpSetup>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>();
  const refresh = () => { void fetch("/api/auth/totp").then((response) => response.json()).then((data) => setEnabled(Boolean(data.enabled))); };
  useEffect(refresh, []);
  const navigation = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes: navigation }} location={{ pathname: "/admin/security" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Account security" style={{ margin: 24, maxWidth: 780 }}>
      <Descriptions items={[{ key: "totp", label: "Authenticator", children: enabled ? "Enabled" : "Not enabled" }]} />
      {!enabled && <Button type="primary" onClick={async () => { const response = await fetch("/api/auth/totp/setup", { method: "POST" }); if (!response.ok) { message.error("Unable to start setup"); return; } setSetup(await response.json()); }}>Set up authenticator</Button>}
      {enabled && <Alert type="success" showIcon message="Authenticator protection is enabled" description="Use an authenticator code or one unused recovery code when signing in." />}
    </ProCard>
    <Modal title="Set up authenticator" open={setup !== undefined} footer={null} onCancel={() => setSetup(undefined)} destroyOnClose>
      {setup !== undefined && <Space direction="vertical" size="middle" style={{ width: "100%" }}><Typography.Paragraph>Enter this secret in an authenticator application, then confirm the current six-digit code.</Typography.Paragraph><Typography.Text code copyable>{setup.secret}</Typography.Text><ProForm onFinish={async (values) => { const response = await fetch("/api/auth/totp/enable", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); if (!response.ok) { message.error("The verification code is invalid"); return false; } const result = await response.json(); setRecoveryCodes(result.recoveryCodes); setSetup(undefined); setEnabled(true); return true; }}><ProFormText name="code" label="Verification code" rules={[{ required: true, pattern: /^\d{6}$/u, message: "Enter a six-digit code" }]} /></ProForm></Space>}
    </Modal>
    <Modal title="Save recovery codes" open={recoveryCodes !== undefined} footer={<Button type="primary" onClick={() => setRecoveryCodes(undefined)}>I saved these codes</Button>} closable={false}><Alert type="warning" showIcon message="Each recovery code works once. They will not be shown again." /><Typography.Paragraph copyable style={{ whiteSpace: "pre-line", marginTop: 16 }}>{recoveryCodes?.join("\n")}</Typography.Paragraph></Modal>
  </ProLayout>;
}
