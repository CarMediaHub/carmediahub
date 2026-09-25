FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY carmediahub-sdk/package.json carmediahub-sdk/pnpm-lock.yaml carmediahub-sdk/tsconfig.json ./carmediahub-sdk/
COPY carmediahub-sdk/pnpm-workspace.yaml ./carmediahub-sdk/
COPY carmediahub-sdk/src ./carmediahub-sdk/src
COPY carmediahub-sdk/spec ./carmediahub-sdk/spec
COPY carmediahub/package.json carmediahub/pnpm-lock.yaml carmediahub/tsconfig.json ./carmediahub/
COPY carmediahub/pnpm-workspace.yaml ./carmediahub/
COPY carmediahub/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY carmediahub/src ./carmediahub/src
COPY carmediahub/config/components.json carmediahub/config/components.schema.json carmediahub/config/component-release.schema.json carmediahub/config/core.schema.json carmediahub/config/core.example.json ./carmediahub/config/
COPY carmediahub/public ./carmediahub/public
COPY carmediahub/admin/package.json carmediahub/admin/pnpm-lock.yaml carmediahub/admin/tsconfig.json carmediahub/admin/.umirc.ts ./carmediahub/admin/
COPY carmediahub/admin/src ./carmediahub/admin/src
RUN npm install --global pnpm@11.19.0 \
  && install_esbuild() { \
       root="$1"; \
       found=0; \
       for installer in "$root"/*/node_modules/esbuild/install.js; do \
         [ -f "$installer" ] || continue; \
         found=1; \
         echo "[docker] running esbuild installer: $installer"; \
         (cd "$(dirname "$installer")" && node install.js) || { \
           status=$?; \
           echo "[docker] esbuild installer failed (status $status): $installer" >&2; \
           return "$status"; \
         }; \
       done; \
       if [ "$found" -eq 0 ]; then \
         echo "[docker] no esbuild installer found under $root" >&2; \
         return 1; \
       fi; \
     } \
  && pnpm --dir carmediahub-sdk install --frozen-lockfile --ignore-scripts \
  && install_esbuild /workspace/carmediahub-sdk/node_modules/.pnpm \
  && pnpm --dir carmediahub-sdk build \
  && pnpm --dir carmediahub install --frozen-lockfile --ignore-scripts \
  && install_esbuild /workspace/carmediahub/node_modules/.pnpm \
  && pnpm --dir carmediahub/admin install --frozen-lockfile --ignore-scripts \
  && pnpm --dir carmediahub build \
  && pnpm --dir carmediahub build:admin

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /workspace/carmediahub/dist ./dist
COPY --from=build /workspace/carmediahub/public ./public
COPY --from=build /workspace/carmediahub/config/components.json /workspace/carmediahub/config/components.schema.json /workspace/carmediahub/config/component-release.schema.json /workspace/carmediahub/config/core.schema.json /workspace/carmediahub/config/core.example.json ./config/
COPY --from=build /workspace/carmediahub/package.json ./package.json
COPY --from=build /workspace/carmediahub/node_modules ./node_modules
RUN groupadd --system --gid 10001 carmediahub \
  && useradd --system --uid 10001 --gid 10001 --home-dir /var/lib/carmediahub --no-create-home --shell /usr/sbin/nologin carmediahub \
  && mkdir -p /var/lib/carmediahub \
  && chown -R carmediahub:carmediahub /var/lib/carmediahub
VOLUME ["/var/lib/carmediahub"]
USER carmediahub
EXPOSE 8787
ENTRYPOINT ["node", "dist/cli.js", "--data-dir", "/var/lib/carmediahub", "--host", "0.0.0.0", "--port", "8787", "--cookie-secure"]
