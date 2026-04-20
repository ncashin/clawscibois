export type OpenCodeConfig = {
  baseUrl: string;
  username?: string;
  password?: string;
  requestTimeoutMs?: number;
};

function log(
  scope: string,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    scope: `discordbot:${scope}`,
    msg,
    ...(extra ?? {}),
  });
  console.log(line);
}

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

type SessionSummary = {
  id: string;
  title?: string;
};

// OpenCode's GET /session returns all sessions the server knows about.
// We use this on bot startup to reconnect Discord threads to their
// pre-existing OpenCode sessions (titled "discord:{threadId}") rather
// than stranding long conversations when the bot restarts.
export async function listSessions(
  config: OpenCodeConfig,
): Promise<SessionSummary[]> {
  const startedAt = Date.now();
  const response = await fetch(new URL("/session", config.baseUrl), {
    method: "GET",
    headers: { ...authHeader(config) },
  });
  const durationMs = Date.now() - startedAt;
  if (!response.ok) {
    const errorText = await readError(response);
    log("opencode", "listSessions: non-2xx", {
      durationMs,
      status: response.status,
      errorText,
    });
    throw new Error(errorText);
  }
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) {
    log("opencode", "listSessions: unexpected payload", {
      durationMs,
      actualType: typeof data,
    });
    throw new Error("OpenCode: /session returned non-array");
  }
  const sessions: SessionSummary[] = data
    .filter(
      (s): s is Record<string, unknown> =>
        s !== null && typeof s === "object",
    )
    .map((s) => ({
      id: String(s.id ?? ""),
      title: typeof s.title === "string" ? s.title : undefined,
    }))
    .filter((s) => s.id !== "");
  log("opencode", "listSessions: response", {
    durationMs,
    count: sessions.length,
  });
  return sessions;
}

export async function createSession(
  config: OpenCodeConfig,
  title?: string,
): Promise<string> {
  const startedAt = Date.now();
  log("opencode", "createSession: request", { title });
  const response = await fetch(new URL("/session", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(config) },
    body: JSON.stringify(title ? { title } : {}),
  });
  const durationMs = Date.now() - startedAt;
  if (!response.ok) {
    const errorText = await readError(response);
    log("opencode", "createSession: non-2xx", {
      title,
      durationMs,
      status: response.status,
      errorText,
    });
    throw new Error(errorText);
  }
  const data = (await response.json()) as { id: string };
  if (!data?.id) {
    log("opencode", "createSession: response had no id", {
      title,
      durationMs,
    });
    throw new Error("OpenCode: create session returned no id");
  }
  log("opencode", "createSession: response", {
    title,
    durationMs,
    sessionId: data.id,
  });
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
  const url = new URL(
    `/session/${encodeURIComponent(sessionId)}/message`,
    config.baseUrl,
  );
  const timeoutMs = config.requestTimeoutMs ?? 180_000;
  const startedAt = Date.now();

  log("opencode", "sendUserMessage: request", {
    sessionId,
    url: url.toString(),
    promptLength: text.length,
    timeoutMs,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader(config) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const isTimeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    log("opencode", "sendUserMessage: fetch failed", {
      sessionId,
      durationMs,
      timeout: isTimeout,
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    if (isTimeout) {
      throw new Error(
        `OpenCode request timed out after ${timeoutMs}ms (session ${sessionId})`,
      );
    }
    throw error;
  }

  const durationMs = Date.now() - startedAt;
  if (!response.ok) {
    const errorText = await readError(response);
    log("opencode", "sendUserMessage: non-2xx", {
      sessionId,
      durationMs,
      status: response.status,
      errorText,
    });
    throw new Error(errorText);
  }
  const responseText = await response.text();
  log("opencode", "sendUserMessage: response", {
    sessionId,
    durationMs,
    status: response.status,
    bodyLength: responseText.length,
  });

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
  const rawTimeout = process.env.OPENCODE_REQUEST_TIMEOUT_MS?.trim();
  const requestTimeoutMs = rawTimeout
    ? Number.parseInt(rawTimeout, 10)
    : undefined;
  return {
    baseUrl,
    username: process.env.OPENCODE_SERVER_USERNAME,
    password: process.env.OPENCODE_SERVER_PASSWORD,
    requestTimeoutMs:
      requestTimeoutMs && Number.isFinite(requestTimeoutMs)
        ? requestTimeoutMs
        : undefined,
  };
}
