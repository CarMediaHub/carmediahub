import { ConfigProvider, theme as antdTheme } from "antd";
import enUS from "antd/locale/en_US";
import koKR from "antd/locale/ko_KR";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useState, type ReactNode } from "react";
import { AdminI18nContext, type AdminLocale, translate } from "./i18n";

export async function getInitialState() {
  try {
    const response = await fetch("/api/me");
    if (!response.ok) return { user: undefined };
    return { user: (await response.json()).user };
  } catch {
    return { user: undefined };
  }
}

export function onRouteChange({ location }: { location: Location }) {
  if (location.pathname !== "/login" && location.pathname !== "/admin/login") {
    void fetch("/api/me").then((response) => { if (response.status === 401) window.location.href = "/admin/login"; });
  }
}

export const request = { errorConfig: { adaptor: (res: Response) => res } };

function PlatformProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ locale?: string; density?: string; theme?: string }>();
  const refresh = () => { void fetch("/api/me").then((response) => response.ok ? response.json() as Promise<{ user?: { locale?: string; density?: string; theme?: string } }> : undefined).then((profile) => { if (profile?.user !== undefined) setUser(profile.user); }).catch(() => undefined); };
  useEffect(() => { refresh(); const listener = () => refresh(); window.addEventListener("cmh:preferences-changed", listener); return () => window.removeEventListener("cmh:preferences-changed", listener); }, []);
  const locale = user?.locale === "zh-CN" ? zhCN : user?.locale === "ko" ? koKR : enUS;
  const language: AdminLocale = user?.locale === "zh-CN" ? "zh-CN" : user?.locale === "ko" ? "ko" : "en";
  const algorithm = user?.theme === "dark" ? antdTheme.darkAlgorithm : undefined;
  return <ConfigProvider locale={locale} componentSize={user?.density === "compact" ? "small" : "middle"} {...(algorithm === undefined ? {} : { theme: { algorithm } })}><AdminI18nContext.Provider value={{ locale: language, t: (key) => translate(language, key) }}>{children}</AdminI18nContext.Provider></ConfigProvider>;
}

export function rootContainer(container: ReactNode) {
  return <PlatformProvider>{container}</PlatformProvider>;
}
