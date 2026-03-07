FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY batch-register.mjs ./
COPY checkin.mjs ./
COPY checkin-cron.mjs ./
COPY query-balance.mjs ./
COPY upload-tokens.mjs ./
COPY .env.example ./

RUN mkdir -p /app/data

CMD ["npm", "run", "checkin:cron"]
