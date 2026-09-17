FROM node:24-bookworm-slim
RUN npm install -g pnpm@11.9.0 @wecom/cli@1.2.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile && mkdir -p .runtime/data .runtime/attachments .runtime/backups .runtime/wecom-cli && chown -R node:node /app
ENV TZ=Asia/Shanghai
USER node
CMD ["pnpm", "api"]
