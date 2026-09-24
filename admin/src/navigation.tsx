import { AppstoreOutlined, AuditOutlined, BellOutlined, ChromeOutlined, CloudServerOutlined, DashboardOutlined, DatabaseOutlined, FolderOpenOutlined, HistoryOutlined, KeyOutlined, LockOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { ProLayout } from "@ant-design/pro-components";
import { Button } from "antd";
import type { ReactNode } from "react";
import { useAdminI18n, type Translator } from "./i18n";

type RouteLike = { path: string; name?: string; icon?: ReactNode };

const routeLabelKeys = {
  "/admin/overview": "nav.overview",
  "/admin/plugins": "nav.plugins",
  "/admin/jobs": "nav.jobs",
  "/admin/history": "nav.history",
  "/admin/catalog": "nav.catalog",
  "/admin/speed": "nav.speed",
  "/admin/notifications": "nav.notifications",
  "/admin/components": "nav.components",
  "/admin/media": "nav.media",
  "/admin/media-sources": "common.remoteSources",
  "/admin/credentials": "common.storedCredentials",
  "/admin/browser": "common.browser",
  "/admin/keys": "nav.keys",
  "/admin/security": "nav.security",
  "/admin/users": "nav.users",
  "/admin/audit": "nav.audit",
} as const;

const adminRouteDefinitions: readonly RouteLike[] = [
  { path: "/admin/overview", icon: <AppstoreOutlined /> },
  { path: "/admin/plugins", icon: <ThunderboltOutlined /> },
  { path: "/admin/jobs", icon: <UnorderedListOutlined /> },
  { path: "/admin/history", icon: <HistoryOutlined /> },
  { path: "/admin/catalog", icon: <AppstoreOutlined /> },
  { path: "/admin/speed", icon: <DashboardOutlined /> },
  { path: "/admin/notifications", icon: <BellOutlined /> },
  { path: "/admin/components", icon: <CloudServerOutlined /> },
  { path: "/admin/media", icon: <FolderOpenOutlined /> },
  { path: "/admin/media-sources", icon: <DatabaseOutlined /> },
  { path: "/admin/credentials", icon: <LockOutlined /> },
  { path: "/admin/browser", icon: <ChromeOutlined /> },
  { path: "/admin/keys", icon: <KeyOutlined /> },
  { path: "/admin/security", icon: <SafetyCertificateOutlined /> },
  { path: "/admin/users", icon: <TeamOutlined /> },
  { path: "/admin/audit", icon: <AuditOutlined /> },
];

export function localizeAdminRoutes<T extends RouteLike>(routes: readonly T[], t: Translator): T[] {
  return routes.map((route) => {
    const key = routeLabelKeys[route.path as keyof typeof routeLabelKeys];
    return key === undefined ? route : { ...route, name: t(key) };
  });
}

export function adminRoutes(t: Translator): RouteLike[] {
  return localizeAdminRoutes(adminRouteDefinitions, t);
}

export function AdminShell({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { t } = useAdminI18n();
  const logout = async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; };
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes: adminRoutes(t) }} location={{ pathname }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={() => void logout()}>{t("nav.signOut")}</Button>]}>{children}</ProLayout>;
}
