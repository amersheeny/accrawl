# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Build context = repo ROOT (pnpm monorepo: needs pnpm-workspace.yaml + packages/contracts).
#   docker build -f apps/engine/Dockerfile --platform linux/amd64 -t accrawl-engine .
#
# linux/amd64 ONLY: the engine drives REAL google-chrome-stable (channel:'chrome') for a TLS
# fingerprint that passes bank WAFs, and Chrome's Linux .deb was amd64-only at time of writing.
# On Apple Silicon this image runs under emulation (works, slower).
#
# Declared once, before any stage. ARG is scoped per stage, so a stage that needs Chrome's version
# re-declares it with no value and inherits what is set here. Two stages each carrying their own default
# is exactly how the stage that downloads Chrome and the stage that verifies it came to disagree.
ARG GOOGLE_CHROME_VERSION=151.0.7922.137-1
ARG GOOGLE_CHROME_SHA256=e6dabf044cf9cd0279cfe86efa431682c18bfc06d06339ce055aaa87ae871727

FROM cgr.dev/chainguard/node:latest-dev@sha256:0cb568f2870d37a9c2a95901bf04d9fe121cfce1b3360c89a540cd75c4c96566 AS build
USER 0
COPY scripts/install-current-node.sh /usr/local/bin/install-current-node
RUN /usr/local/bin/install-current-node
ENV PATH=/opt/node-current/bin:$PATH
RUN test "$(node --version)" = "v26.7.0" \
 && test "$(npm --version)" = "12.0.2" \
 && test "$(pnpm --version)" = "11.22.0"
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=accrawl-pnpm-v11,target=/root/.local/share/pnpm/store/v11,sharing=locked \
    pnpm install --frozen-lockfile \
 && pnpm --filter @accrawl/contracts build \
 && pnpm --filter @accrawl/engine build \
 && pnpm --filter @accrawl/engine --prod deploy /out \
 && fetch_blob_path=/out/node_modules/.pnpm/fetch-blob@3.2.0/node_modules/fetch-blob/from.js \
 && test -f "$fetch_blob_path" \
 && sed -i \
      "s/^import DOMException from 'node-domexception'$/const DOMException = globalThis.DOMException/" \
      "$fetch_blob_path" \
 && test "$(grep -c '^const DOMException = globalThis.DOMException$' "$fetch_blob_path")" = "1" \
 && test "$(grep -c "node-domexception" "$fetch_blob_path")" = "0"

FROM cgr.dev/chainguard/node:latest-dev@sha256:0cb568f2870d37a9c2a95901bf04d9fe121cfce1b3360c89a540cd75c4c96566 AS chrome-package
USER 0
# Real Google Chrome (not Playwright's bundled Chromium) — different TLS fingerprint. Download the
# versioned package from Google's signed repository and verify the package digest published in its
# current Packages index before extracting only Chrome itself.
ARG GOOGLE_CHROME_VERSION
ARG GOOGLE_CHROME_SHA256
RUN apk add --no-cache xz=5.8.3-r2
RUN wget --quiet --https-only --output-document=/tmp/google-chrome.deb \
    "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${GOOGLE_CHROME_VERSION}_amd64.deb" \
 && echo "${GOOGLE_CHROME_SHA256}  /tmp/google-chrome.deb" | sha256sum -c -
RUN mkdir -p /tmp/google-chrome-package /chrome-root \
 && cd /tmp/google-chrome-package \
 && ar x /tmp/google-chrome.deb \
 && xz --decompress --stdout data.tar.xz \
    | tar -xf - -C /chrome-root ./opt/google/chrome

FROM cgr.dev/chainguard/rust:latest-dev@sha256:70a73cab576cb5262ed69944fa8393d3d85f49c82220056f00e84337059fba6e AS rav1e-toolchain
USER 0
# gtk-3's current image-loader graph reaches rav1e. Rebuild rav1e's current stable C ABI with the
# current Rust toolchain and dependency graph: the packaged CLI embeds abandoned/vulnerable crates,
# while Chrome only needs the shared library transitively through libheif.
ARG RAV1E_VERSION=0.8.1
ARG RAV1E_COMMIT=1fe82de02510767539e89b2ee6fa846920ae2686
ARG RAV1E_SOURCE_DATE_EPOCH=1750066517
ARG RAV1E_PASTEY_PATCH_COMMIT=c247d53ae43dd1312dbd90117c45e4c0ee6b06ce
ARG RAV1E_PASTEY_PATCH_SHA256=6ad50a59fc2d1e64b033d312db5cffce93eea10fd38f4960f7f01032f31ec0c6
RUN test "$(rustc --version)" = "rustc 1.97.1 (8bab26f4f 2026-07-14)" \
 && test "$(cargo --version)" = "cargo 1.97.1 (c980f4866 2026-06-30)" \
 && apk add --no-cache \
      build-base=1-r9 \
      cargo-c=0.10.24-r1 \
      git=2.55.0-r4 \
      nasm=3.02-r0 \
      pax-utils=1.3.11-r1 \
 && test "$(cargo cinstall --version)" = "cargo-c 0.10.24+cargo-0.98.0"
ENV SOURCE_DATE_EPOCH=${RAV1E_SOURCE_DATE_EPOCH}
ENV TZ=UTC
ENV LANG=C
ENV LC_ALL=C
ENV CARGO_BUILD_JOBS=1
ENV CARGO_INCREMENTAL=0
ENV ZERO_AR_DATE=1

FROM rav1e-toolchain AS rav1e-source
# Current Rust makes two previously implicit output lifetimes warn. Apply the same annotations as
# upstream commit b7bf39066ec4f004c9b9cdb81c91734ec2edfac7, without importing that commit's other changes.
# The patch is vendored rather than fetched. GitHub's `commit/<sha>.patch` route now returns 404 for
# this commit even though the commit itself is still there, which broke every engine image build. A
# build step that depends on one upstream URL staying renderable is a build that stops working without
# anything here changing. `RAV1E_PASTEY_PATCH_COMMIT` stays as the record of where it came from.
COPY patches/rav1e-v0.8.1-pastey.patch /tmp/rav1e-pastey.patch
RUN git clone --branch "v${RAV1E_VERSION}" --depth 1 https://github.com/xiph/rav1e.git /src/rav1e \
 && test "$(git -C /src/rav1e rev-parse HEAD)" = "${RAV1E_COMMIT}" \
 && echo "${RAV1E_PASTEY_PATCH_SHA256}  /tmp/rav1e-pastey.patch" | sha256sum -c - \
 && git -C /src/rav1e apply --check /tmp/rav1e-pastey.patch \
 && git -C /src/rav1e apply /tmp/rav1e-pastey.patch \
 && grep -Fx 'pastey = "0.1.0"' /src/rav1e/Cargo.toml \
 && sed -i 's/^pastey = "0\.1\.0"$/pastey = "0.2.3"/' /src/rav1e/Cargo.toml \
 && grep -Fx 'pastey = "0.2.3"' /src/rav1e/Cargo.toml \
 && sed -i "s/PlaneSlice<T>)/PlaneSlice<'_, T>)/" /src/rav1e/src/predict.rs \
 && sed -i "s/) -> TileRestorationState {/) -> TileRestorationState<'_> {/" \
      /src/rav1e/src/tiling/tile_restoration_state.rs \
 && grep -F "PlaneSlice<'_, T>)" /src/rav1e/src/predict.rs \
 && grep -F "TileRestorationState<'_> {" /src/rav1e/src/tiling/tile_restoration_state.rs
ARG RAV1E_CARGO_LOCK_SHA256=c1f31707786499629e99426fc4131f4b1df7e2faaae11c8cf28e60eb23c424c1
COPY apps/engine/rav1e/Cargo.lock /src/rav1e/Cargo.lock
RUN echo "${RAV1E_CARGO_LOCK_SHA256}  /src/rav1e/Cargo.lock" | sha256sum -c -

FROM rav1e-toolchain AS rav1e-build-a
COPY --from=rav1e-source /src/rav1e /src/rav1e
WORKDIR /src/rav1e
RUN mkdir /reproducibility-run-a
RUN cargo cinstall --release --locked --no-default-features \
      --features "asm,threading,capi" \
      --library-type cdylib \
      --prefix /usr \
      --destdir /rav1e-root \
 && mkdir -p /rav1e-root/usr/share/accrawl/rav1e \
 && cp Cargo.lock /rav1e-root/usr/share/accrawl/rav1e/Cargo.lock \
 && test -f /rav1e-root/usr/lib/librav1e.so.0.8.1

FROM rav1e-toolchain AS rav1e-build-b
COPY --from=rav1e-source /src/rav1e /src/rav1e
WORKDIR /src/rav1e
RUN mkdir /reproducibility-run-b
RUN cargo cinstall --release --locked --no-default-features \
      --features "asm,threading,capi" \
      --library-type cdylib \
      --prefix /usr \
      --destdir /rav1e-root \
 && mkdir -p /rav1e-root/usr/share/accrawl/rav1e \
 && cp Cargo.lock /rav1e-root/usr/share/accrawl/rav1e/Cargo.lock \
 && test -f /rav1e-root/usr/lib/librav1e.so.0.8.1

# This target is both the production source of librav1e and a standalone release gate. The two
# builds have separate rootfs inputs and no shared Cargo/target cache. Their complete installed
# trees must have identical paths, types, ownership, modes, link targets, sizes, and file bytes.
FROM rav1e-toolchain AS rav1e-reproducibility
COPY --from=rav1e-build-a /rav1e-root /rav1e-root
COPY --from=rav1e-build-b /rav1e-root /rav1e-comparison-root
RUN <<'EOF'
set -eu

count_named_files() {
  find "$1" -type f -name "$2" -print | awk 'END { print NR + 0 }'
}

assert_expected_artifacts() {
  root="$1"
  test -f "${root}/usr/lib/librav1e.so.0.8.1"
  test -f "${root}/usr/share/accrawl/rav1e/Cargo.lock"
  test "$(count_named_files "${root}" rav1e.h)" = "1"
  test "$(count_named_files "${root}" rav1e.pc)" = "1"
  test "$(count_named_files "${root}" '*.a')" = "0"
}

artifact_manifest() {
  root="$1"
  output="$2"
  (
    cd "${root}"
    find . -mindepth 1 -print | LC_ALL=C sort | while IFS= read -r artifact; do
      mode="$(stat -c '%a' "${artifact}")"
      owner="$(stat -c '%u:%g' "${artifact}")"
      if [ -L "${artifact}" ]; then
        printf 'L|%s|%s|%s|%s\n' \
          "${owner}" "${mode}" "${artifact}" "$(readlink "${artifact}")"
      elif [ -d "${artifact}" ]; then
        printf 'D|%s|%s|%s\n' "${owner}" "${mode}" "${artifact}"
      elif [ -f "${artifact}" ]; then
        size="$(stat -c '%s' "${artifact}")"
        digest="$(sha256sum "${artifact}" | awk '{ print $1 }')"
        printf 'F|%s|%s|%s|%s|%s\n' \
          "${owner}" "${mode}" "${size}" "${digest}" "${artifact}"
      else
        echo "Unsupported installed artifact type: ${artifact}" >&2
        exit 1
      fi
    done
  ) > "${output}"
}

assert_expected_artifacts /rav1e-root
assert_expected_artifacts /rav1e-comparison-root
artifact_manifest /rav1e-root /tmp/rav1e-build-a.manifest
artifact_manifest /rav1e-comparison-root /tmp/rav1e-build-b.manifest

digest_a="$(sha256sum /tmp/rav1e-build-a.manifest | awk '{ print $1 }')"
digest_b="$(sha256sum /tmp/rav1e-build-b.manifest | awk '{ print $1 }')"
if [ "${digest_a}" != "${digest_b}" ]; then
  echo "rav1e installed artifacts are not reproducible: ${digest_a} != ${digest_b}" >&2
  diff -u /tmp/rav1e-build-a.manifest /tmp/rav1e-build-b.manifest || true
  exit 1
fi
echo "rav1e installed artifact manifest: ${digest_a}"
EOF

FROM cgr.dev/chainguard/node:latest@sha256:8bfea508c3b8af20865728e06311a088c4dee31052fca6acb5ac6ea7712aeda6 AS chrome-runtime
USER 0
COPY --from=build /opt/node-current/bin/node /usr/bin/node
COPY --from=build /usr/lib/libatomic.so.1* /usr/lib/
RUN test "$(node --version)" = "v26.7.0"
# The minimal Chainguard runtime deliberately omits a package manager. Borrow apk only while assembling
# the image so Chrome receives current Wolfi runtime libraries and fonts, then remove apk and BusyBox.
COPY --from=chrome-package /sbin/apk /sbin/apk
COPY --from=chrome-package /usr/lib/libapk.so.* /usr/lib/
RUN apk add --no-cache \
    font-liberation=2.1.5-r5 \
    font-noto-cjk=0.0_git20220127-r2 \
    font-noto-emoji=2.051-r2 \
    font-opensans=0_git20210927-r2 \
    fontconfig=2.18.3-r0 \
    gtk-3=3.24.52-r2 \
    icu-data-full=75.1-r42 \
    libnss=3.127-r1 \
    mesa=26.2.0-r0 \
    mesa-glx=26.2.0-r0 \
    nss=3.127-r1 \
    libudev=261.2-r1 \
    xdg-utils=1.2.1-r8
# Replace Wolfi's rav1e payload in place: gtk-3 requires the package record, but Chrome needs only its
# shared C ABI. Remove the packaged executable, library, and now-inaccurate package SBOM before installing
# the rebuilt library plus its resolved Cargo.lock. The runtime is distroless and its ELF closure is verified.
RUN test "$(/usr/bin/busybox find /var/lib/db/sbom -name 'rav1e-*.spdx.json' | /usr/bin/busybox wc -l)" = "1" \
 && /usr/bin/busybox rm -f /usr/bin/rav1e /usr/lib/librav1e.so* /var/lib/db/sbom/rav1e-*.spdx.json
COPY --from=rav1e-reproducibility /rav1e-root/usr/lib/librav1e.so* /usr/lib/
COPY --from=rav1e-reproducibility /rav1e-root/usr/share/accrawl/rav1e /usr/share/accrawl/rav1e
COPY --from=rav1e-reproducibility /usr/bin/scanelf /usr/bin/scanelf
COPY --from=chrome-package /chrome-root/opt/google/chrome /opt/google/chrome
ARG GOOGLE_CHROME_VERSION
# Chrome's Debian package includes optional Qt input-method bridges. This service is headless and has
# no Qt event loop, so remove the unused dlopen targets rather than ship objects with unresolved Qt ABI.
RUN /usr/bin/busybox rm -f /opt/google/chrome/libqt5_shim.so /opt/google/chrome/libqt6_shim.so \
 && chrome_version="$(/opt/google/chrome/chrome --version | /usr/bin/busybox sed 's/[[:space:]]*$//')" \
 && echo "${chrome_version}" \
 && test "${chrome_version}" = "Google Chrome ${GOOGLE_CHROME_VERSION%-1}" \
 && apk info --installed rav1e \
 && test ! -e /usr/bin/rav1e \
 && test -z "$(/usr/bin/busybox find /var/lib/db/sbom -name 'rav1e-*.spdx.json' -print -quit)" \
 && scanelf -nLRBF '%F;%n' /opt/google/chrome /usr/lib \
      | /usr/bin/busybox awk -F';' \
        '$2 != "" { count=split($2, dependencies, ","); for (i=1; i<=count; i++) if (dependencies[i] !~ /^\//) { print $1 ": unresolved " dependencies[i]; missing=1 } } END { exit missing ? 1 : 0 }' \
 && mkdir -p /data/screenshots \
 && chown 1000:1000 /data/screenshots \
 && /usr/bin/busybox rm -f /sbin/apk /usr/bin/scanelf /usr/lib/libapk.so.* \
 && for path in /usr/bin/*; do \
      if [ -L "$path" ] && [ "$(/usr/bin/busybox readlink "$path")" = "/bin/busybox" ]; then \
        /usr/bin/busybox rm "$path"; \
      fi; \
    done \
 && /usr/bin/busybox rm -f /usr/bin/busybox
ENV NODE_ENV=production
ENV PORT=8080
ENV PLATFORM=postgres
ENV HOME=/tmp
EXPOSE 8080
USER 1000:1000

FROM chrome-runtime AS runtime
WORKDIR /app
COPY --from=build /out/dist ./dist
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
CMD ["dist/index.js"]
