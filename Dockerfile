FROM node:22.1.0

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY tsconfig*.json ./

COPY src ./src

CMD ["npx", "tsx", "src/index.ts"]
