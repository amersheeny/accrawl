#!/bin/sh
set -eu

NODE_VERSION=26.7.0
NODE_LINUX_X64_SHA256=bd6b6c31e377bad9ad579bed72e5bc11f4c879ac9452ad51d30e646ea3d828df
NODE_LINUX_ARM64_SHA256=925aa6157dd37542d0d7f2e28b7bf61e7b39284411210b0498bc3788db4aef68

case "$(uname -m)" in
  x86_64)
    node_arch=x64
    node_sha256="${NODE_LINUX_X64_SHA256}"
    ;;
  aarch64)
    node_arch=arm64
    node_sha256="${NODE_LINUX_ARM64_SHA256}"
    ;;
  *)
    echo "Unsupported Node build architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

archive="/tmp/node-v${NODE_VERSION}-linux-${node_arch}.tar.gz"
wget --quiet --https-only --output-document="${archive}" \
  "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.gz"
echo "${node_sha256}  ${archive}" | sha256sum -c -
mkdir -p /opt/node-current
tar -xzf "${archive}" -C /opt/node-current --strip-components 1
rm "${archive}"

NPM_CONFIG_PREFIX=/opt/node-current \
  /opt/node-current/bin/npm install --global --ignore-scripts npm@12.0.2 pnpm@11.22.0
test "$(/opt/node-current/bin/node --version)" = "v${NODE_VERSION}"
test "$(/opt/node-current/bin/npm --version)" = "12.0.2"
test "$(/opt/node-current/bin/pnpm --version)" = "11.22.0"
