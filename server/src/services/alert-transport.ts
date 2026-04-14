import fs from "node:fs/promises";
import path from "node:path";

export type AlertSeverity = "warning" | "critical";

export interface AlertPayload {
  key: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  dedupeKey: string;
  details?: Record<string, unknown>;
}

export interface AlertTransport {
  send(payload: AlertPayload): Promise<{ channel: "pushover" | "webhook" | "mock_file"; delivered: boolean }>;
}

function readEnv(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveMockAlertPath(): string {
  const explicit = readEnv("PAPERCLIP_ALERT_MOCK_FILE");
  if (explicit) return explicit;
  const home = readEnv("PAPERCLIP_HOME") ?? process.cwd();
  return path.resolve(home, "report", "mock-alerts.ndjson");
}

async function appendMockAlert(payload: AlertPayload) {
  const filePath = resolveMockAlertPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(
    filePath,
    `${JSON.stringify({
      sentAt: new Date().toISOString(),
      ...payload,
    })}\n`,
    "utf8",
  );
}

async function sendPushover(payload: AlertPayload): Promise<boolean> {
  const token = readEnv("PUSHOVER_TOKEN");
  const user = readEnv("PUSHOVER_USER");
  if (!token || !user) return false;

  const body = new URLSearchParams({
    token,
    user,
    title: payload.title.slice(0, 250),
    message: payload.message.slice(0, 1024),
    priority: payload.severity === "critical" ? "1" : "0",
    sound: payload.severity === "critical" ? "siren" : "pushover",
    url_title: "Paperclip",
    url: readEnv("PAPERCLIP_PUBLIC_URL") ?? "https://paperclip.nullmas.no",
  });

  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Pushover returned HTTP ${response.status}: ${text || response.statusText}`);
  }
  return true;
}

async function sendWebhook(payload: AlertPayload): Promise<boolean> {
  const webhookUrl = readEnv("PAPERCLIP_ALERT_WEBHOOK_URL");
  if (!webhookUrl) return false;

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sentAt: new Date().toISOString(),
      ...payload,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Alert webhook returned HTTP ${response.status}: ${text || response.statusText}`);
  }
  return true;
}

export function createAlertTransport(): AlertTransport {
  return {
    async send(payload) {
      if (readEnv("PUSHOVER_TOKEN") && readEnv("PUSHOVER_USER")) {
        await sendPushover(payload);
        return { channel: "pushover", delivered: true };
      }

      if (readEnv("PAPERCLIP_ALERT_WEBHOOK_URL")) {
        await sendWebhook(payload);
        return { channel: "webhook", delivered: true };
      }

      await appendMockAlert(payload);
      return { channel: "mock_file", delivered: false };
    },
  };
}
