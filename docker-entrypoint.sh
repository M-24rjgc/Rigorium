#!/usr/bin/env bash
set -euo pipefail

RIGORIUM_HOME="${RIGORIUM_HOME:-/root/.rigorium}"
CONFIG_FILE="$RIGORIUM_HOME/rigorium.yaml"

mkdir -p \
  "$RIGORIUM_HOME/projects" \
  "$RIGORIUM_HOME/router" \
  "$RIGORIUM_HOME/skills" \
  "$RIGORIUM_HOME/plugins" \
  "$RIGORIUM_HOME/memory"

if [ -d "$CONFIG_FILE" ]; then
  echo "[rigorium-docker] ERROR: $CONFIG_FILE is a directory, not a config file." >&2
  echo "[rigorium-docker] If you intended to mount a YAML config, create the host file first or remove the bind mount and use RIGORIUM_* env vars." >&2
  exit 1
fi

# ── Generate config from env vars if no config file is mounted ────────
if [ ! -f "$CONFIG_FILE" ]; then
  MODEL="${RIGORIUM_MODEL:-openrouter/deepseek/deepseek-v4-flash}"
  LIGHT_MODEL="${RIGORIUM_LIGHT_MODEL:-openrouter/qwen/qwen3-8b}"
  API_KEY="${RIGORIUM_API_KEY:-PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE}"
  API_URL="${RIGORIUM_API_URL:-https://openrouter.ai/api/v1}"

  # Derive provider name from model string (e.g. "openrouter/deepseek/deepseek-v4-flash" -> "openrouter")
  PROVIDER="${MODEL%%/*}"
  LIGHT_PROVIDER="${LIGHT_MODEL%%/*}"
  # Model ID is everything after the first slash
  MODEL_ID="${MODEL#*/}"
  LIGHT_MODEL_ID="${LIGHT_MODEL#*/}"

  # Router section shared by both same-provider and cross-provider branches
  ROUTER_SECTION="router:
  scenarios:
    default: ${MODEL}
  fallback:
    default:
      - ${MODEL}
  zeroUsageRetry:
    enabled: true
    maxAttempts: 2
  tokenSaver:
    enabled: true
    judge: ${LIGHT_MODEL}
    defaultTier: medium
    judgeTimeoutMs: 15000
    tiers:
      simple:
        model: ${LIGHT_MODEL}
        description: \"Simple greetings, confirmations, single-step Q&A, trivial file writes, remembering rules\"
      medium:
        model: ${LIGHT_MODEL}
        description: \"Single tool call, short text generation, 1-2 file read/write, code generation\"
      complex:
        model: ${MODEL}
        description: \"Needs sub-agent orchestration: parallel workstreams, delegation to specialized agents\"
      reasoning:
        model: ${MODEL}
        description: \"Deep single-agent work: multi-file operations, data analysis, multi-step workflows, web research, structured reports from many sources\"
    rules:
      - \"complex is ONLY for tasks that need sub-agent orchestration or parallel delegation — do NOT use it for single-agent multi-step work\"
      - \"Multi-file operations, data analysis, and multi-step workflows without orchestration should be reasoning\"
      - \"Simple file creation (1-2 files) or single code generation is medium\"
      - \"Trivial greetings, confirmations, remembering rules, or reading one file and answering a short question is simple\"
  autoOrchestrate:
    enabled: true
    triggerTiers:
      - complex
    slimSystemPrompt: true
    allowedTools:
      - agent
      - read_file
      - grep
      - glob
      - read_skill
  stats:
    enabled: true"

  if [ "$PROVIDER" = "$LIGHT_PROVIDER" ]; then
    # Same provider for both models
    cat > "$CONFIG_FILE" <<YAML
schemaVersion: 1
agent:
  model: ${MODEL}
model:
  providers:
    ${PROVIDER}:
      protocol: openai
      url: ${API_URL}
      apiKey: ${API_KEY}
      models:
        ${MODEL_ID}:
          capabilities:
            maxOutputTokens: 32768
        ${LIGHT_MODEL_ID}:
          capabilities:
            maxOutputTokens: 16384
cron:
  enabled: true
${ROUTER_SECTION}
YAML
  else
    # Different providers — declare both
    LIGHT_API_URL="${RIGORIUM_LIGHT_API_URL:-${API_URL}}"
    LIGHT_API_KEY="${RIGORIUM_LIGHT_API_KEY:-${API_KEY}}"
    cat > "$CONFIG_FILE" <<YAML
schemaVersion: 1
agent:
  model: ${MODEL}
model:
  providers:
    ${PROVIDER}:
      protocol: openai
      url: ${API_URL}
      apiKey: ${API_KEY}
      models:
        ${MODEL_ID}:
          capabilities:
            maxOutputTokens: 32768
    ${LIGHT_PROVIDER}:
      protocol: openai
      url: ${LIGHT_API_URL}
      apiKey: ${LIGHT_API_KEY}
      models:
        ${LIGHT_MODEL_ID}:
          capabilities:
            maxOutputTokens: 16384
cron:
  enabled: true
${ROUTER_SECTION}
YAML
  fi

  echo "[rigorium-docker] Generated config at $CONFIG_FILE (provider=$PROVIDER, model=$MODEL, light=$LIGHT_MODEL)"
fi

# ── Forward proxy env vars ────────────────────────────────────────────
if [ -n "${RIGORIUM_PROXY:-}" ]; then
  export http_proxy="$RIGORIUM_PROXY"
  export https_proxy="$RIGORIUM_PROXY"
  export HTTP_PROXY="$RIGORIUM_PROXY"
  export HTTPS_PROXY="$RIGORIUM_PROXY"
  echo "[rigorium-docker] Proxy set to $RIGORIUM_PROXY"
fi

echo "[rigorium-docker] Starting Rigorium (gateway + UI server)..."
echo "[rigorium-docker] Config: $CONFIG_FILE"
echo "[rigorium-docker] UI will be available at http://0.0.0.0:${SERVER_PORT:-3001}"

# ── Remove stale auth token so the bridge never uses a leftover value ──
rm -f "$RIGORIUM_HOME/server-token"

# ── Start gateway + UI server via concurrently ────────────────────────
# The bridge retries for RIGORIUM_BRIDGE_TIMEOUT ms (default 30s) which
# may be too short on cold Docker starts. We first wait for the gateway
# health endpoint before launching the bridge, eliminating the race.
cd /app

GATEWAY_PORT="${RIGORIUM_GATEWAY_PORT:-18789}"
GATEWAY_HEALTH_URL="http://127.0.0.1:${GATEWAY_PORT}/health"
GATEWAY_READY_TIMEOUT="${RIGORIUM_GATEWAY_READY_TIMEOUT:-120}"

wait_for_gateway() {
  echo "[rigorium-docker] Waiting for gateway to become ready (timeout=${GATEWAY_READY_TIMEOUT}s)..."
  local elapsed=0
  while [ "$elapsed" -lt "$GATEWAY_READY_TIMEOUT" ]; do
    if curl -sf "$GATEWAY_HEALTH_URL" > /dev/null 2>&1; then
      echo "[rigorium-docker] Gateway is ready (took ${elapsed}s)."
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "[rigorium-docker] WARNING: Gateway did not become ready within ${GATEWAY_READY_TIMEOUT}s, starting bridge anyway." >&2
  return 0
}

node dist/src/cli/rigorium.js server &
GATEWAY_PID=$!

wait_for_gateway

node --import tsx ui/server/index.js &
BRIDGE_PID=$!

# If either process exits, kill the other and propagate the exit code.
wait -n $GATEWAY_PID $BRIDGE_PID 2>/dev/null
EXIT_CODE=$?
kill $GATEWAY_PID $BRIDGE_PID 2>/dev/null
wait $GATEWAY_PID $BRIDGE_PID 2>/dev/null
exit $EXIT_CODE
