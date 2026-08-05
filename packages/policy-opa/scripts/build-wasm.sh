#!/usr/bin/env bash
# Compile the Rego modules in ../policy to the WebAssembly fixtures committed
# beside them.
#
# `opa build -t wasm` needs the `opa` binary. Rather than make that a
# dependency of the test suite or of CI, the compiled modules are committed and
# this script regenerates them on demand. Run it whenever a .rego changes, and
# commit the .wasm in the same change so the two cannot drift.
#
# Requires Docker only. On Colima:
#   DOCKER_HOST=unix://$HOME/.colima/<profile>/docker.sock ./scripts/build-wasm.sh
#
# Everything happens inside ./policy because that is the one directory the
# container is guaranteed to be able to write to: a Colima VM shares $HOME, not
# the host's temporary directory.
set -euo pipefail

image="openpolicyagent/opa:1.19.0"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

staging="${here}/policy/.build"
rm -rf "$staging"
mkdir -p "$staging"
trap 'rm -rf "$staging"' EXIT

build() {
  local module="$1" entrypoint="$2"
  docker run --rm -v "${here}/policy:/policy" -w /policy \
    "$image" build -t wasm -e "$entrypoint" "${module}.rego" -o ".build/${module}.tar.gz"
  # Bundle members carry absolute paths, so extract the whole thing into a
  # staging directory rather than next to the sources it would overwrite.
  tar -xzf "${staging}/${module}.tar.gz" -C "$staging"
  install -m 644 "${staging}/policy.wasm" "${here}/policy/${module}.wasm"
  echo "built policy/${module}.wasm from policy/${module}.rego (${entrypoint})"
}

build forge forge/policy/decision
build untrusted forge/policy/decision
