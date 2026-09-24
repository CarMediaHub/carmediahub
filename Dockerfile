FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY carmediahub-sdk/package.json carmediahub-sdk/pnpm-lock.yaml carmediahub-sdk/tsconfig.json ./carmediahub-sdk/
COPY carmediahub-sdk/src ./carmediahub-sdk/src
COPY carmediahub-sdk/spec ./carmediahub-sdk/spec
COPY carmediahub/package.json carmediahub/pnpm-lock.yaml carmediahub/tsconfig.json ./carmediahub/
COPY carmediahub/src ./carmediahub/src
COPY carmediahub/config/components.json carmediahub/config/components.schema.json carmediahub/config/component-release.schema.json carmediahub/config/core.schema.json carmediahub/config/core.example.json ./carmediahub/config/
COPY carmediahub/public ./carmediahub/public
COPY carmediahub/admin/package.json carmediahub/admin/pnpm-lock.yaml carmediahub/admin/tsconfig.json carmediahub/admin/.umirc.ts ./carmediahub/admin/
COPY carmediahub/admin/src ./carmediahub/admin/src
RUN corepack enable && pnpm --dir carmediahub-sdk install --frozen-lockfile && pnpm --dir carmediahub-sdk build && pnpm --dir carmediahub install --frozen-lockfile && pnpm --dir carmediahub/admin install --frozen-lockfile && pnpm --dir carmediahub build && pnpm --dir carmediahub build:admin

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /workspace/carmediahub/dist ./dist
COPY --from=build /workspace/carmediahub/public ./public
COPY --from=build /workspace/carmediahub/config/components.json /workspace/carmediahub/config/components.schema.json /workspace/carmediahub/config/component-release.schema.json /workspace/carmediahub/config/core.schema.json /workspace/carmediahub/config/core.example.json ./config/
COPY --from=build /workspace/carmediahub/package.json ./package.json
COPY --from=build /workspace/carmediahub/node_modules ./node_modules
RUN mkdir -p /var/lib/carmediahub
VOLUME ["/var/lib/carmediahub"]
EXPOSE 8787
ENTRYPOINT ["node", "dist/cli.js", "--data-dir", "/var/lib/carmediahub", "--host", "0.0.0.0", "--port", "8787", "--cookie-secure"]
