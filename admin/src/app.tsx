import { message } from "antd";

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
export { message };
