FROM node:22-slim
WORKDIR /app

RUN corepack enable

COPY . .

# pnpm v10 blocks dependency build scripts unless allow-listed.
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

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=8788

VOLUME /data/floway
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["pnpm", "--filter", "@floway-dev/platform-node", "exec", "tsx", "docker-entry.ts"]
