# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
#
# Production image for the Accrawl control-plane.
#
# Build context = repo ROOT (needs pnpm-workspace.yaml + packages/contracts). Build with:
#   docker buildx build --platform linux/amd64 -f apps/control-plane/Dockerfile \
#     -t accrawl-control-plane --load .
#
# The runtime contains only the compiled control-plane, migrations, and its
# production dependency closure. Browser, test, build, and monorepo source
# dependencies remain in the build stage.

# Build the public contracts and control plane, then emit a self-contained
# production bundle at /out.
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
RUN --mount=type=cache,id=accrawl-pnpm-v11,target=/root/.local/share/pnpm/store/v11,sharing=locked \
    pnpm install --frozen-lockfile \
 && pnpm --filter @accrawl/contracts build \
 && pnpm --filter @accrawl/control-plane build \
 && pnpm --filter @accrawl/control-plane --prod deploy /out \
 && fetch_blob_path=/out/node_modules/.pnpm/fetch-blob@3.2.0/node_modules/fetch-blob/from.js \
 && test -f "$fetch_blob_path" \
 && sed -i \
      "s/^import DOMException from 'node-domexception'$/const DOMException = globalThis.DOMException/" \
      "$fetch_blob_path" \
 && test "$(grep -c '^const DOMException = globalThis.DOMException$' "$fetch_blob_path")" = "1" \
 && test "$(grep -c "node-domexception" "$fetch_blob_path")" = "0"

FROM cgr.dev/chainguard/node:latest@sha256:f6c05914c890eb9a36836503015b21a38f54eca322b5de9a3ef475b32d7f4172 AS runtime
USER 0
COPY --from=build /opt/node-current/bin/node /usr/bin/node
COPY --from=build /usr/lib/libatomic.so.1* /usr/lib/
RUN test "$(node --version)" = "v26.7.0"
RUN for path in /usr/bin/*; do \
      if [ -L "$path" ] && [ "$(/usr/bin/busybox readlink "$path")" = "/bin/busybox" ]; then \
        /usr/bin/busybox rm "$path"; \
      fi; \
    done \
 && /usr/bin/busybox rm -f /usr/bin/busybox
USER 65532
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /out/dist ./dist
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
# The compiled migrator resolves ../../migrations from /app/dist/db.
COPY --from=build /out/migrations ./migrations

EXPOSE 3000

# PostgreSQL deployments apply schema migrations and least-privilege engine grants before the API
# starts. A deployment that keeps its records elsewhere skips the PostgreSQL bootstrap automatically,
# so the same immutable image is safe in both topologies.
# Distroless invokes the script with Node as PID 1, so graceful-shutdown signals reach the API directly.
CMD ["dist/container-entrypoint.js"]
