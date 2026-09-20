import { LockOutlined, SafetyCertificateOutlined, UserOutlined } from "@ant-design/icons";
import { LoginForm, ProFormText } from "@ant-design/pro-components";
import { Card, message, Typography } from "antd";

export default function Login() {
  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#f6f8f6" }}>
    <Card style={{ width: 420, maxWidth: "calc(100vw - 32px)" }}>
      <Typography.Title level={2}>CarMediaHub Core</Typography.Title>
      <Typography.Paragraph type="secondary">Sign in to your local deployment.</Typography.Paragraph>
      <LoginForm onFinish={async (values) => {
        const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
        if (!response.ok) { message.error((await response.json()).code === "CMH.AUTH.TOTP_REQUIRED" ? "Enter your authenticator or recovery code" : "Sign-in failed"); return false; }
        window.location.href = "/admin/overview"; return true;
      }}>
        <ProFormText name="username" fieldProps={{ size: "large", prefix: <UserOutlined /> }} placeholder="Username" rules={[{ required: true }]} />
        <ProFormText.Password name="password" fieldProps={{ size: "large", prefix: <LockOutlined /> }} placeholder="Password" rules={[{ required: true }]} />
        <ProFormText name="otp" fieldProps={{ size: "large", prefix: <SafetyCertificateOutlined /> }} placeholder="Authenticator or recovery code" />
      </LoginForm>
    </Card>
  </main>;
}
