// Shared client export constants.
import type { EpxConfig } from "../../types";


/** Provider key owned by this project; the only key any exporter ever emits. */
export const OPENCODE_PROVIDER_ID = "easyproxy";

export const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

/**
 * Env var carrying the proxy admission key to opencode. The config only ever holds the
 * `{env:...}` reference, so the secret never lands on disk. opencode substitutes it at
 * load time.
 */
export const OPENCODE_API_KEY_ENV = "EASYPROXY_OPENCODE_API_KEY";

/**
 * Env var carrying the proxy admission key to Kilo. Independent of OpenCode's
 * so the two clients can keep distinct credentials.
 */
export const KILO_API_KEY_ENV = "EASYPROXY_KILO_API_KEY";
export const KILO_API_KEY_ENV_REF = `{env:${KILO_API_KEY_ENV}}`;
export const KILO_CONFIG_SCHEMA = "https://app.kilo.ai/config.json";

/** Env reference shared by apiKey and the dedicated proxy admission header. */
export const OPENCODE_API_KEY_ENV_REF = `{env:${OPENCODE_API_KEY_ENV}}`;

/**
 * Hermes interpolates `${VAR}` anywhere in config.yaml, so the credential stays
 * in the environment exactly as it does for OpenCode.
 */
export const HERMES_API_KEY_ENV = "EASYPROXY_HERMES_API_KEY";
export const HERMES_API_KEY_ENV_REF = `\${${HERMES_API_KEY_ENV}}`;

/** OpenClaw interpolates `${UPPERCASE_VAR}` and fails closed when it is unset. */
export const OPENCLAW_API_KEY_ENV = "EASYPROXY_OPENCLAW_API_KEY";
export const OPENCLAW_API_KEY_ENV_REF = `\${${OPENCLAW_API_KEY_ENV}}`;

/** Pi expands `$VAR` inside provider headers via `parseConfigValueTemplate`. */
export const PI_API_KEY_ENV = "EASYPROXY_PI_API_KEY";
export const PI_API_KEY_ENV_REF = `$${PI_API_KEY_ENV}`;

/** OMP resolves bare env var names inside provider headers via `$envExact`. */
export const OMP_API_KEY_ENV = "EASYPROXY_OMP_API_KEY";

/**
 * Placeholder credential for loopback-only clients (Kimi, Pi). A loopback
 * bind needs no real admission key, so we emit the same placeholder the Grok
 * managed block uses rather than a user secret. Pi resolves `apiKey` before
 * building its model list and hides the provider when an env reference is unset.
 */
export const LOOPBACK_API_KEY_PLACEHOLDER = "easyproxy-loopback";

/**
 * Legacy name retained for existing consumers. Gajae exports now use the
 * non-secret loopback placeholder and do not emit an environment reference.
 */
export const GAJAE_API_KEY_ENV = "EASYPROXY_GAJAE_API_KEY";

/** Pi's wire-dialect selector for an OpenAI-compatible endpoint. */
export const PI_API_DIALECT = "openai-completions";

/** Fallback only when the model has no known output limit; always clamped to context. */
export const SCHEMA_REQUIRED_OUTPUT_BUDGET = 32_000;

/** Deterministic loopback default for exported provider-block helpers in tests. */
export const OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG: EpxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as EpxConfig;
