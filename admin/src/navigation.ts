import type { Translator } from "./i18n";

type RouteLike = { path: string; name?: string };

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

export function localizeAdminRoutes<T extends RouteLike>(routes: readonly T[], t: Translator): T[] {
  return routes.map((route) => {
    const key = routeLabelKeys[route.path as keyof typeof routeLabelKeys];
    return key === undefined ? route : { ...route, name: t(key) };
  });
}
