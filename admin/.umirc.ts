import { defineConfig } from "@umijs/max";

export default defineConfig({
  antd: {},
  access: {},
  model: {},
  initialState: {},
  layout: false,
  dva: false,
  history: { type: "browser" },
  base: "/admin/",
  publicPath: "/admin/",
  hash: true,
  routes: [
    { path: "/login", component: "./Login" },
    { path: "/", redirect: "/overview" },
    { path: "/overview", component: "./Overview" },
    { path: "/components", component: "./Components" },
    { path: "/media", component: "./Media" },
    { path: "/keys", component: "./Keys" },
    { path: "/security", component: "./Security" },
    { path: "/users", component: "./Users" },
    { path: "/plugins", component: "./Plugins" }
  ]
});
