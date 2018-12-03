FROM postgres:9-alpine
WORKDIR /root

RUN apk add --update --no-cache nodejs

COPY node_modules node_modules
COPY migrations migrations
COPY ops ops

ENTRYPOINT ["bash", "ops/entry.sh"]
