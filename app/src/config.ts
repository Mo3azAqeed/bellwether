/** Central, validated place to read environment configuration from. Nothing
 * else in the app should touch `process.env` directly — that way a missing
 * or malformed value fails fast at startup with one clear message instead of
 * surfacing later as a confusing runtime error deep in some handler.
 *
 * Each section validates only the vars it needs, independently, so a script
 * that only touches the database (e.g. the seed migration) doesn't fail
 * because a Slack token isn't set — and each accessor is cached so
 * validation only runs once. */

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var ${key}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

let databaseConfig: { url: string } | undefined;

export function getDatabaseConfig() {
  if (!databaseConfig) {
    databaseConfig = { url: required("DATABASE_URL") };
  }
  return databaseConfig;
}

let slackConfig: { botToken: string; signingSecret: string; appToken: string } | undefined;

export function getSlackConfig() {
  if (!slackConfig) {
    slackConfig = {
      botToken: required("SLACK_BOT_TOKEN"),
      signingSecret: required("SLACK_SIGNING_SECRET"),
      appToken: required("SLACK_APP_TOKEN"),
    };
  }
  return slackConfig;
}

let posthogConfig: { apiKey: string; projectId: string; host: string } | undefined;

export function getPostHogConfig() {
  if (!posthogConfig) {
    posthogConfig = {
      apiKey: required("POSTHOG_API_KEY"),
      projectId: required("POSTHOG_PROJECT_ID"),
      host: process.env.POSTHOG_HOST || "https://eu.posthog.com",
    };
  }
  return posthogConfig;
}

let port: number | undefined;

export function getPort(): number {
  if (port === undefined) {
    const raw = process.env.PORT || "3000";
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`PORT must be a positive integer, got "${raw}".`);
    }
    port = parsed;
  }
  return port;
}

/** Validates and returns every config section. Use this at app startup (not
 * from a script that only needs one section) so all missing vars are
 * reported together instead of one at a time. */
export function getConfig() {
  return {
    database: getDatabaseConfig(),
    slack: getSlackConfig(),
    posthog: getPostHogConfig(),
    port: getPort(),
  };
}
