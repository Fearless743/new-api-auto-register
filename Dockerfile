FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY batch-register.mjs ./
COPY checkin.mjs ./
COPY query-balance.mjs ./
COPY service.mjs ./
COPY storage.mjs ./
COPY upload-tokens.mjs ./
COPY .env.example ./

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["npm", "run", "service"]
