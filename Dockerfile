# The official Node.js image, from Amazon's copy of Docker Hub's library
# (Docker Hub limits how often build machines may download from it).
FROM public.ecr.aws/docker/library/node:22-alpine

WORKDIR /app

# Amazon's certificates for the database in us-east-2, so the site can check
# it is really talking to our database (connections are encrypted).
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/us-east-2/us-east-2-bundle.pem ./rds-ca.pem

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY lib ./lib
COPY migrations ./migrations
COPY public ./public

ENV NODE_ENV=production
USER node
EXPOSE 8080

CMD ["node", "server.js"]
