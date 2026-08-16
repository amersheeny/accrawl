# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Builds the web SPA (pnpm monorepo) and bakes it into a Caddy image that also proxies the API.
# Build context = repo ROOT:
#   docker build -f infra/Caddy.Dockerfile -t accrawl-web .
FROM cgr.dev/chainguard/node:latest-dev@sha256:39708a466eb9e1c4a49abc6931dc8aaf8d3d4565fe6977a53bff0ce1c357a405 AS build
USER 0
COPY scripts/install-current-node.sh /usr/local/bin/install-current-node
RUN /usr/local/bin/install-current-node
ENV PATH=/opt/node-current/bin:$PATH
RUN test "$(node --version)" = "v26.7.0" \
 && test "$(npm --version)" = "12.0.2" \
 && test "$(pnpm --version)" = "11.21.0"
WORKDIR /repo
COPY . .
# Deployed build stamp (git short SHA), threaded in by the launcher. Declared right before the SPA build so
# only the build step's cache is busted when the SHA changes (source-only rebuilds stay fully cached because
# .dockerignore excludes .git). vite bakes it via `define` (see apps/web/vite.config.ts) → the console footer.
ARG ACCRAWL_VERSION=unknown
ENV ACCRAWL_VERSION=$ACCRAWL_VERSION
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @accrawl/contracts build \
 && pnpm --filter @accrawl/web build

FROM cgr.dev/chainguard/go:latest-dev@sha256:acd5088274d279f3343deff04b61ccf040327272e81eaeb33f4ccb0753d9a1c9 AS caddy-build
USER 0
ARG CADDY_VERSION=2.11.4
ARG CADDY_COMMIT=e2eee6a7fce366321294c9c2a79f3146891dcbdf
ARG GOVULNCHECK_VERSION=1.7.0
COPY patches/caddy-v2.11.4-cel-go-v0.30.patch /tmp/caddy-cel-go.patch
RUN test "$(go env GOVERSION)" = "go1.26.6" \
 && git clone --branch "v${CADDY_VERSION}" --depth 1 https://github.com/caddyserver/caddy.git /src/caddy \
 && test "$(git -C /src/caddy rev-parse HEAD)" = "${CADDY_COMMIT}" \
 && git -C /src/caddy apply --check /tmp/caddy-cel-go.patch \
 && git -C /src/caddy apply /tmp/caddy-cel-go.patch
WORKDIR /src/caddy
# Caddy's release module graph can lag security releases between Caddy tags. Compile the current Caddy
# source only after advancing every compatible direct and transitive Go module to its latest release.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go get -u ./cmd/caddy \
 && CGO_ENABLED=0 go run "golang.org/x/vuln/cmd/govulncheck@v${GOVULNCHECK_VERSION}" ./cmd/caddy \
 && CGO_ENABLED=0 go build -trimpath -o /out/caddy ./cmd/caddy \
 && go run "golang.org/x/vuln/cmd/govulncheck@v${GOVULNCHECK_VERSION}" \
      -mode=binary /out/caddy \
 && go version -m /out/caddy \
 && mkdir -p /runtime/data /runtime/config \
 && chown -R 65532:65532 /runtime

FROM cgr.dev/chainguard/static:latest@sha256:f68e3a8244c7d0f4cd56635aaff8e6a533cf6cc3850d8fb339567a5782d6a0b0
COPY --from=build /usr/lib/libatomic.so.1* /usr/lib/
COPY --from=caddy-build /out/caddy /usr/bin/caddy
COPY --from=caddy-build /runtime/data /data
COPY --from=caddy-build /runtime/config /config
COPY --from=build /repo/apps/web/dist /srv
COPY infra/Caddyfile /etc/caddy/Caddyfile
ENV XDG_DATA_HOME=/data
ENV XDG_CONFIG_HOME=/config
USER 65532:65532
EXPOSE 8088
ENTRYPOINT ["/usr/bin/caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
