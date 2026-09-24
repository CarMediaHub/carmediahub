import { AppstoreOutlined, CloudServerOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { ProCard, ProForm, ProFormSelect, ProFormText, ProLayout } from "@ant-design/pro-components";
import { Alert, Button, Descriptions, Modal, Space, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";
import { AdminShell } from "../navigation";

type TotpSetup = { secret: string; otpauthUrl: string };

export default function Security() {
  const { t } = useAdminI18n();
  const [enabled, setEnabled] = useState(false);
  const [setup, setSetup] = useState<TotpSetup>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>();
  const [locale, setLocale] = useState("en");
  const [timeZone, setTimeZone] = useState("UTC");
  const [theme, setTheme] = useState("system");
  const [density, setDensity] = useState("comfortable");
  const refresh = () => { void Promise.all([fetch("/api/auth/totp").then((response) => response.json() as Promise<{ enabled?: boolean }>), fetch("/api/me").then(async (response) => response.ok ? await response.json() as { user?: { locale?: string; timeZone?: string; theme?: string; density?: string } } : {})]).then(([totp, profile]) => { setEnabled(Boolean(totp.enabled)); setLocale(profile.user?.locale ?? "en"); setTimeZone(profile.user?.timeZone ?? "UTC"); setTheme(profile.user?.theme ?? "system"); setDensity(profile.user?.density ?? "comfortable"); }); };
  useEffect(refresh, []);
  return <AdminShell pathname="/admin/security">
    <ProCard title={t("security.account")} style={{ margin: 24, maxWidth: 780 }}>
      <Descriptions items={[{ key: "totp", label: t("security.authenticator"), children: enabled ? t("security.enabled") : t("security.disabled") }]} />
      {!enabled && <Button type="primary" onClick={async () => { const response = await fetch("/api/auth/totp/setup", { method: "POST" }); if (!response.ok) { message.error(t("security.updateFailed")); return; } setSetup(await response.json()); }}>{t("security.setup")}</Button>}
      {enabled && <Alert type="success" showIcon message={t("security.enabledHint")} description={t("security.enabledDescription")} />}
    </ProCard>
    <ProCard title={t("security.password")} style={{ margin: 24, maxWidth: 780 }}>
      <ProForm layout="vertical" onFinish={async (values) => { const response = await fetch("/api/auth/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); if (!response.ok) { message.error(t("security.passwordInvalid")); return false; } message.success(t("security.passwordChanged")); return true; }}>
        <ProFormText.Password name="currentPassword" label={t("security.currentPassword")} rules={[{ required: true }]} />
        <ProFormText.Password name="newPassword" label={t("security.newPassword")} rules={[{ required: true, min: 12 }]} />
      </ProForm>
    </ProCard>
    <ProCard title={t("security.preferences")} style={{ margin: 24, maxWidth: 780 }}>
      <ProForm key={`${locale}:${timeZone}:${theme}:${density}`} layout="inline" initialValues={{ locale, timeZone, theme, density }} onFinish={async (values) => { const response = await fetch("/api/me/preferences", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); if (!response.ok) { message.error(t("security.updateFailed")); return false; } const result = await response.json(); setLocale(result.user.locale); setTimeZone(result.user.timeZone); setTheme(result.user.theme); setDensity(result.user.density); window.dispatchEvent(new Event("cmh:preferences-changed")); message.success(t("security.updated")); return true; }}>
        <ProFormSelect name="locale" label={t("security.language")} options={[{ label: "English", value: "en" }, { label: "简体中文", value: "zh-CN" }, { label: "한국어", value: "ko" }]} rules={[{ required: true }]} />
        <ProFormSelect name="timeZone" label={t("security.timeZone")} options={[{ label: "UTC", value: "UTC" }, { label: "Asia/Shanghai", value: "Asia/Shanghai" }, { label: "Europe/London", value: "Europe/London" }, { label: "America/Los_Angeles", value: "America/Los_Angeles" }]} rules={[{ required: true }]} />
        <ProFormSelect name="theme" label={t("security.theme")} options={[{ label: t("security.system"), value: "system" }, { label: t("security.light"), value: "light" }, { label: t("security.dark"), value: "dark" }]} rules={[{ required: true }]} />
        <ProFormSelect name="density" label={t("security.density")} options={[{ label: t("security.comfortable"), value: "comfortable" }, { label: t("security.compact"), value: "compact" }]} rules={[{ required: true }]} />
      </ProForm>
    </ProCard>
    <Modal title={t("security.setup")} open={setup !== undefined} footer={null} onCancel={() => setSetup(undefined)} destroyOnClose>
      {setup !== undefined && <Space direction="vertical" size="middle" style={{ width: "100%" }}><Typography.Paragraph>{t("security.setupDescription")}</Typography.Paragraph><Typography.Text code copyable>{setup.secret}</Typography.Text><ProForm onFinish={async (values) => { const response = await fetch("/api/auth/totp/enable", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); if (!response.ok) { message.error(t("security.invalidCode")); return false; } const result = await response.json(); setRecoveryCodes(result.recoveryCodes); setSetup(undefined); setEnabled(true); return true; }}><ProFormText name="code" label={t("security.verificationCode")} rules={[{ required: true, pattern: /^\d{6}$/u, message: t("security.sixDigits") }]} /></ProForm></Space>}
    </Modal>
    <Modal title={t("security.saveCodes")} open={recoveryCodes !== undefined} footer={<Button type="primary" onClick={() => setRecoveryCodes(undefined)}>{t("security.savedCodes")}</Button>} closable={false}><Alert type="warning" showIcon message={t("security.codesWarning")} /><Typography.Paragraph copyable style={{ whiteSpace: "pre-line", marginTop: 16 }}>{recoveryCodes?.join("\n")}</Typography.Paragraph></Modal>
  </AdminShell>;
}
