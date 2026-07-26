#!/bin/sh
set -e

REPO="sasazemzulin058-debug/pi-hermes-memory"
PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
AGENT_NPM="${HOME}/.pi/agent/npm"
TMPDIR_BASE="${TMPDIR:-${PREFIX_DIR}/tmp}"

mkdir -p "$TMPDIR_BASE"
TMP_WORK_DIR=$(mktemp -d -p "$TMPDIR_BASE" 2>/dev/null || mktemp -d)
trap 'rm -rf "$TMP_WORK_DIR"' EXIT INT TERM

LATEST_TAG=$(curl -fsSL -L --retry 3 "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="v0.9.0-android.1"
fi
VERSION="${LATEST_TAG#v}"
RELEASE_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}"

echo "📱 Installing pi-hermes-memory for Android ARM64 (${LATEST_TAG})..."

mkdir -p "${AGENT_NPM}"
curl -fsSL -L --retry 3 -o "${TMP_WORK_DIR}/pi-hermes-memory.tgz" "${RELEASE_URL}/pi-hermes-memory-${VERSION}.tgz"

cd "${AGENT_NPM}"
export CXXFLAGS="-std=c++20"
npm install "${TMP_WORK_DIR}/pi-hermes-memory.tgz" --force --legacy-peer-deps > /dev/null 2>&1

echo "🎉 Installed pi-hermes-memory successfully!"
