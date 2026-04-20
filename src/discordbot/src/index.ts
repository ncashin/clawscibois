import { createDiscordAdapter } from "@chat-adapter/discord";
import { Chat, type Thread } from "chat";
import { formatDiscordReply } from "./formatDiscordReply.ts";
import {
  createSession,
  health,
  listSessions,
  loadOpenCodeConfigFromEnv,
  sendUserMessage,
  type OpenCodeConfig,
} from "./opencode.ts";
import { createSqliteState } from "./stateSqlite.ts";

const opencode: OpenCodeConfig = loadOpenCodeConfigFromEnv();

// Sessions: we keep a hot in-memory cache of threadId -> OpenCode sessionId,
// but the authoritative record lives in OpenCode itself (sessions created
// with title "discord:{threadId}" persist across bot restarts there). On
// cache miss we call listSessions() to find an existing session before
// creating a new one. The cache is populated at startup too (see primeSessionCache).
const sessionByThread = new Map<string, string>();

// If set, the bot will only respond to messages whose containing channel
// matches this Discord channel ID. Users can still start Discord-native
// threads under that channel — the chat-sdk's `thread.channelId` resolves
// to the parent channel regardless of whether we're in the raw channel or
// a sub-thread, so either works. Unset = respond everywhere the bot is
// mentioned (previous behavior).
const allowedChannelId = process.env.DISCORD_ALLOWED_CHANNEL_ID?.trim() || null;

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

// The chat-sdk normalises Discord channel IDs to "discord:{guildId}:{channelId}".
// Users configure a bare snowflake in DISCORD_ALLOWED_CHANNEL_ID for UX, so
// we match against the trailing segment.
function threadIsInAllowedChannel(thread: Thread): boolean {
  if (!allowedChannelId) return true;
  const parts = thread.channelId.split(":");
  const tail = parts[parts.length - 1];
  return tail === allowedChannelId;
}

function createDiscordAdapterFromEnvironment() {
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  const publicKey = process.env.DISCORD_PUBLIC_KEY?.trim();
  const applicationId = process.env.DISCORD_APPLICATION_ID?.trim();
  if (!botToken || !publicKey || !applicationId) {
    const missing = [
      !botToken && "DISCORD_BOT_TOKEN",
      !publicKey && "DISCORD_PUBLIC_KEY",
      !applicationId && "DISCORD_APPLICATION_ID",
    ].filter(Boolean);
    console.error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        "Add them to a .env file at the repo root (see .env.example) and run Compose from that directory.",
    );
    process.exit(1);
  }
  return createDiscordAdapter({
    botToken,
    publicKey,
    applicationId,
    userName: process.env.DISCORD_BOT_USERNAME ?? "opencode",
  });
}

const SESSION_TITLE_PREFIX = "discord:";
const sessionTitleForThread = (threadId: string) =>
  `${SESSION_TITLE_PREFIX}${threadId}`;

async function sessionForThread(threadId: string): Promise<string> {
  const existing = sessionByThread.get(threadId);
  if (existing) {
    log("session", "reusing existing session (cache hit)", {
      threadId,
      sessionId: existing,
    });
    return existing;
  }

  // Cache miss. Before creating a fresh session, ask OpenCode if one
  // already exists for this thread — it will, if the bot has restarted
  // mid-conversation. This preserves context across restarts.
  const title = sessionTitleForThread(threadId);
  const sessions = await listSessions(opencode);
  const found = sessions.find((s) => s.title === title);
  if (found) {
    log("session", "reusing existing session (server lookup)", {
      threadId,
      sessionId: found.id,
    });
    sessionByThread.set(threadId, found.id);
    return found.id;
  }

  log("session", "creating new session", { threadId });
  const id = await createSession(opencode, title);
  sessionByThread.set(threadId, id);
  return id;
}

// Populate the session cache at startup from OpenCode's list. Not strictly
// required — sessionForThread() would do the lookup on first miss anyway —
// but it means the first message after a restart doesn't wait for the
// list+match round-trip.
async function primeSessionCache(): Promise<void> {
  try {
    const sessions = await listSessions(opencode);
    let primed = 0;
    for (const s of sessions) {
      if (s.title?.startsWith(SESSION_TITLE_PREFIX)) {
        const threadId = s.title.slice(SESSION_TITLE_PREFIX.length);
        if (threadId && !sessionByThread.has(threadId)) {
          sessionByThread.set(threadId, s.id);
          primed++;
        }
      }
    }
    log("session", "primed session cache", {
      primed,
      totalOpenCodeSessions: sessions.length,
    });
  } catch (err) {
    // Non-fatal: we'll populate the cache lazily on first message.
    log("session", "primeSessionCache failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Chat state: persist subscriptions, locks, etc. to SQLite so they
// survive bot restarts. Path defaults to /workspace/.chat-state/state.db
// (which the container's entrypoint creates with app-only perms). In
// local dev or testing, point STATE_DB_PATH somewhere writable.
const stateDbPath =
  process.env.STATE_DB_PATH?.trim() || "/workspace/.chat-state/state.db";
const chatState = createSqliteState({ path: stateDbPath });

const chat = new Chat({
  userName: process.env.DISCORD_BOT_USERNAME ?? "slopscibois",
  adapters: {
    discord: createDiscordAdapterFromEnvironment(),
  },
  state: chatState,
});

async function handlePrompt(thread: Thread, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  const startedAt = Date.now();
  log("prompt", "received", {
    threadId: thread.id,
    promptLength: trimmed.length,
    promptPreview: trimmed.slice(0, 80),
  });

  const status = await thread.post("On it boss...");
  try {
    const sid = await sessionForThread(thread.id);
    const reply = await sendUserMessage(opencode, sid, trimmed);
    const formatted = reply ? formatDiscordReply(reply) : "";
    const totalMs = Date.now() - startedAt;
    log("prompt", "replied", {
      threadId: thread.id,
      sessionId: sid,
      replyLength: formatted.length,
      totalMs,
    });
    await status.edit(formatted || "(OpenCode returned an empty reply.)");
  } catch (error) {
    const totalMs = Date.now() - startedAt;
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    log("prompt", "failed", {
      threadId: thread.id,
      totalMs,
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage,
    });
    await status.edit(`Error: ${errorMessage}`);
  }
}

chat.onNewMention(async (thread, message) => {
  if (message.author.isMe || message.author.isBot) {
    log("event", "onNewMention: ignoring self/bot", { threadId: thread.id });
    return;
  }
  if (!threadIsInAllowedChannel(thread)) {
    log("event", "onNewMention: ignoring (outside allowed channel)", {
      threadId: thread.id,
      channelId: thread.channelId,
      allowedChannelId,
    });
    return;
  }
  log("event", "onNewMention: subscribing + handling", {
    threadId: thread.id,
    authorId: message.author.id,
  });
  await thread.subscribe();
  await handlePrompt(thread, message.text);
});

chat.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe || message.author.isBot) {
    log("event", "onSubscribedMessage: ignoring self/bot", {
      threadId: thread.id,
    });
    return;
  }
  // Defense-in-depth: if the allowed-channel gate was added after the bot
  // had already subscribed to threads elsewhere, we'd still be paged on
  // follow-ups. Check here too.
  if (!threadIsInAllowedChannel(thread)) {
    log("event", "onSubscribedMessage: ignoring (outside allowed channel)", {
      threadId: thread.id,
      channelId: thread.channelId,
      allowedChannelId,
    });
    return;
  }
  log("event", "onSubscribedMessage: handling", {
    threadId: thread.id,
    authorId: message.author.id,
  });
  await handlePrompt(thread, message.text);
});

function runGatewayLoop(): void {
  void (async () => {
    const discord = chat.getAdapter("discord");
    const sessionMilliseconds = 6 * 60 * 60 * 1000;
    for (;;) {
      console.log("[discord] gateway listener starting");
      let gatewayTask: Promise<unknown> | undefined;
      await discord.startGatewayListener(
        {
          waitUntil: (task: Promise<unknown>) => {
            gatewayTask = task;
            void task.catch((event: unknown) =>
              console.error("[discord] gateway task:", event),
            );
          },
        },
        sessionMilliseconds,
        undefined,
        undefined,
      );
      if (gatewayTask) {
        await gatewayTask;
      }
      console.log("[discord] gateway listener stopped; reconnecting");
    }
  })();
}

await chat.initialize();
await health(opencode);
await primeSessionCache();

const port = Number(process.env.PORT ?? 3001);

Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/webhooks/discord") {
      return chat.webhooks.discord(req, {
        waitUntil: (task: Promise<unknown>) => {
          void task.catch((event: unknown) =>
            console.error("[discord] webhook task:", event),
          );
        },
      });
    }
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    return new Response("Not found", { status: 404 });
  },
});

runGatewayLoop();

console.log(
  `Discord interactions: http://0.0.0.0:${port}/api/webhooks/discord`,
);
