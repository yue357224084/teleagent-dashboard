FROM node:22-alpine

RUN apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone

ENV TZ=Asia/Shanghai NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com && npm cache clean --force
COPY . .

ENV PORT=8580
ENV HOST=0.0.0.0
EXPOSE 8580
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8580/api/auth/me >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
