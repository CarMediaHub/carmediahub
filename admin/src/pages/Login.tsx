import { LockOutlined, SafetyCertificateOutlined, UserOutlined } from "@ant-design/icons";
import { LoginForm, ProFormText } from "@ant-design/pro-components";
import { Card, message, Typography } from "antd";
import { useAdminI18n } from "../i18n";

export default function Login() {
  const { t } = useAdminI18n();
  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#f6f8f6" }}>
    <Card style={{ width: 420, maxWidth: "calc(100vw - 32px)" }}>
      <Typography.Title level={2}>{t("login.title")}</Typography.Title>
      <Typography.Paragraph type="secondary">{t("login.subtitle")}</Typography.Paragraph>
      <LoginForm submitter={{ searchConfig: { submitText: t("login.submit") } }} onFinish={async (values) => {
        const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
        if (!response.ok) { message.error((await response.json()).code === "CMH.AUTH.TOTP_REQUIRED" ? t("login.otpRequired") : t("login.failed")); return false; }
        window.location.href = "/admin/overview"; return true;
      }}>
        <ProFormText name="username" fieldProps={{ size: "large", prefix: <UserOutlined /> }} placeholder={t("login.username")} rules={[{ required: true }]} />
        <ProFormText.Password name="password" fieldProps={{ size: "large", prefix: <LockOutlined /> }} placeholder={t("login.password")} rules={[{ required: true }]} />
        <ProFormText name="otp" fieldProps={{ size: "large", prefix: <SafetyCertificateOutlined /> }} placeholder={t("login.otp")} />
      </LoginForm>
    </Card>
  </main>;
}
