export type OpenCodeConfig = {
  baseUrl: string;
  username?: string;
  password?: string;
};

function authHeader(config: OpenCodeConfig): Record<string, string> {
  if (!config.password) return {};
  const username = config.username ?? "opencode";
  const credentials = `${username}:${config.password}`;
  const base64Encoded = Buffer.from(credentials, "utf8").toString("base64");
  return { Authorization: `Basic ${base64Encoded}` };
}

async function readError(response: Response): Promise<string> {
  const bodyText = await response.text();
  return bodyText || `${response.status} ${response.statusText}`;
}

export type HealthOptions = {
  retries?: number;
  delayMilliseconds?: number;
};

export async function health(
  config: OpenCodeConfig,
  options?: HealthOptions,
): Promise<void> {
  const additionalAttemptsAfterFirst = options?.retries ?? 60;
  const delayMilliseconds = options?.delayMilliseconds ?? 1000;
  let lastError: unknown;
  for (let attempt = 0; attempt <= additionalAttemptsAfterFirst; attempt++) {
    try {
      const response = await fetch(new URL("/global/health", config.baseUrl), {
        headers: { ...authHeader(config) },
      });
      if (response.ok) return;
      lastError = new Error(await readError(response));
    } catch (error) {
      lastError = error;
    }
    if (attempt < additionalAttemptsAfterFirst) {
      await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(String(lastError));
}

export async function createSession(
  config: OpenCodeConfig,
  title?: string,
): Promise<string> {
  const response = await fetch(new URL("/session", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(config) },
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!response.ok) throw new Error(await readError(response));
  const data = (await response.json()) as { id: string };
  if (!data?.id) throw new Error("OpenCode: create session returned no id");
  return data.id;
}

type MessagePart = { type: string; text?: string };

function extractAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const object = payload as Record<string, unknown>;
  const parts = object.parts;
  if (!Array.isArray(parts)) return "";
  const lines: string[] = [];
  for (const item of parts) {
    if (!item || typeof item !== "object") continue;
    const messagePart = item as MessagePart;
    if (messagePart.type === "text" && typeof messagePart.text === "string") {
      lines.push(messagePart.text);
    }
  }
  return lines.join("\n").trim();
}

export async function sendUserMessage(
  config: OpenCodeConfig,
  sessionId: string,
  text: string,
): Promise<string> {
  const body = {
    parts: [{ type: "text", text }],
  };
  const response = await fetch(
    new URL(`/session/${encodeURIComponent(sessionId)}/message`, config.baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader(config) },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw new Error(await readError(response));
  const responseText = await response.text();
  if (!responseText) {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    return responseText;
  }
  const fromParts = extractAssistantText(parsed);
  if (fromParts) return fromParts;
  if (parsed && typeof parsed === "object") {
    const parsedObject = parsed as Record<string, unknown>;
    const info = parsedObject.info as Record<string, unknown> | undefined;
    if (info && typeof info.content === "string") return info.content;
  }
  return responseText;
}

export function loadOpenCodeConfigFromEnv(): OpenCodeConfig {
  const baseUrl = process.env.OPENCODE_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    throw new Error("OPENCODE_URL is required (e.g. http://opencode:4096)");
  }
  return {
    baseUrl,
    username: process.env.OPENCODE_SERVER_USERNAME,
    password: process.env.OPENCODE_SERVER_PASSWORD,
  };
}
