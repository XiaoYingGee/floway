# Stage 1: Build web assets
FROM node:22-slim AS web-builder
WORKDIR /app
RUN corepack enable
COPY . .
RUN node -e "\
  const fs=require('fs');\
  const p=JSON.parse(fs.readFileSync('package.json','utf8'));\
  p.pnpm=p.pnpm||{};\
  p.pnpm.onlyBuiltDependencies=Array.from(new Set([\
    ...(p.pnpm.onlyBuiltDependencies||[]),\
    'sharp','esbuild','vue-demi'\
  ]));\
  fs.writeFileSync('package.json',JSON.stringify(p,null,2));"
RUN pnpm install --no-frozen-lockfile \
  && pnpm --filter @floway-dev/web run build

# Stage 2: Node app (API only, no static serving)
FROM node:22-slim AS app
WORKDIR /app
RUN corepack enable
COPY --from=web-builder /app .
ENV NODE_ENV=production PORT=8788
VOLUME /data/floway
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@floway-dev/platform-node", "run", "start"]

# Stage 3: Nginx (static assets + reverse proxy)
FROM nginx:alpine AS nginx
COPY --from=web-builder /app/apps/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
