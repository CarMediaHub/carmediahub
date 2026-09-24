import { AppstoreOutlined, AuditOutlined, BellOutlined, CloudServerOutlined, DashboardOutlined, FolderOpenOutlined, HistoryOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, Space, Statistic, Tag } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";

type Application = { id: string; name: string; category: string; route: string; vehicleSupported: boolean };
type Component = { id: string; displayName: string; kind: string; version: string; status: string; executable: string };

export default function Overview() {
  const { t } = useAdminI18n();
  const [applications, setApplications] = useState<Application[]>([]);
  const [components, setComponents] = useState<Component[]>([]);
  useEffect(() => { void Promise.all([fetch("/api/apps").then((response) => response.json()), fetch("/api/components/catalog").then((response) => response.ok ? response.json() : { components: [] })]).then(([apps, managed]) => { setApplications(apps.applications ?? []); setComponents(managed.components ?? []); }); }, []);
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes: [{ path: "/admin/overview", name: t("nav.overview"), icon: <AppstoreOutlined /> }, { path: "/admin/plugins", name: t("nav.plugins"), icon: <ThunderboltOutlined /> }, { path: "/admin/jobs", name: t("nav.jobs"), icon: <HistoryOutlined /> }, { path: "/admin/history", name: t("nav.history"), icon: <HistoryOutlined /> }, { path: "/admin/catalog", name: t("nav.catalog"), icon: <AppstoreOutlined /> }, { path: "/admin/speed", name: t("nav.speed"), icon: <DashboardOutlined /> }, { path: "/admin/notifications", name: t("nav.notifications"), icon: <BellOutlined /> }, { path: "/admin/components", name: t("nav.components"), icon: <CloudServerOutlined /> }, { path: "/admin/media", name: t("nav.media"), icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: t("nav.keys"), icon: <KeyOutlined /> }, { path: "/admin/security", name: t("nav.security"), icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: t("nav.users"), icon: <TeamOutlined /> }] }} location={{ pathname: "/admin/overview" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>{t("nav.signOut")}</Button>]}> 
    <Space direction="vertical" size="large" style={{ width: "100%", padding: 24 }}><Button href="/admin/audit" icon={<AuditOutlined />}>{t("nav.audit")}</Button>
      <ProCard split="vertical"><Statistic title={t("overview.applications")} value={applications.length} /><Statistic title={t("overview.components")} value={components.length} /><Statistic title={t("overview.gateway")} value={t("overview.healthy")} /></ProCard>
      <ProCard title={t("overview.applicationList")}><ProTable<Application> rowKey="id" search={false} options={false} dataSource={applications} columns={[{ title: t("overview.name"), dataIndex: "name" }, { title: t("overview.category"), dataIndex: "category" }, { title: t("overview.route"), dataIndex: "route" }, { title: t("overview.vehicle"), dataIndex: "vehicleSupported", render: (_, row) => row.vehicleSupported ? <Tag color="green">{t("overview.supported")}</Tag> : <Tag>{t("overview.desktop")}</Tag> }]} /></ProCard>
      <ProCard title={t("overview.catalog")}><ProTable<Component> rowKey="id" search={false} options={false} dataSource={components} columns={[{ title: t("overview.component"), dataIndex: "displayName" }, { title: t("overview.kind"), dataIndex: "kind" }, { title: t("overview.version"), dataIndex: "version" }, { title: t("overview.status"), dataIndex: "status" }, { title: t("overview.executable"), dataIndex: "executable" }]} /></ProCard>
    </Space>
  </ProLayout>;
}
