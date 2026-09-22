import { ConfigProvider } from "antd";
import enUS from "antd/locale/en_US";
import koKR from "antd/locale/ko_KR";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useState, type ReactNode } from "react";

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
  const [user, setUser] = useState<{ locale?: string; density?: string }>();
  useEffect(() => { void fetch("/api/me").then((response) => response.ok ? response.json() as Promise<{ user?: { locale?: string; density?: string } }> : undefined).then((profile) => { if (profile?.user !== undefined) setUser(profile.user); }).catch(() => undefined); }, []);
  const locale = user?.locale === "zh-CN" ? zhCN : user?.locale === "ko" ? koKR : enUS;
  return <ConfigProvider locale={locale} componentSize={user?.density === "compact" ? "small" : "middle"}>{children}</ConfigProvider>;
}

export function rootContainer(container: ReactNode) {
  return <PlatformProvider>{container}</PlatformProvider>;
}
