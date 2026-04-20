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

// Hot cache. OpenCode itself is the source of truth (sessions titled
// "discord:{threadId}" survive bot restarts); on a cache miss we do a
// server-side lookup before creating a new session.
const sessionByThread = new Map<string, string>();

// When set, only respond in this channel (and Discord-native threads
// under it). Unset = respond wherever the bot is mentioned.
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

// chat-sdk normalises Discord channel IDs to "discord:{guildId}:{channelId}".
// Users configure the bare snowflake, so match against the trailing segment.
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

  // Cache miss. Ask OpenCode for an existing session first; one will
  // be there if the bot restarted mid-conversation.
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

// Fill the session cache from OpenCode once at startup so the first
// message after restart doesn't pay the list+match round-trip.
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
    // Non-fatal; sessionForThread will populate lazily on first miss.
    log("session", "primeSessionCache failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// SQLite-backed chat state so subscriptions/locks survive restart.
// /workspace/.chat-state/state.db is created by the entrypoint with
// app-only perms; override with STATE_DB_PATH for local dev.
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
  // Defense-in-depth: subscriptions made before the channel gate was
  // added would otherwise still route here.
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

// Auto-subscribe sub-threads under the allowed channel without an
// initial @-mention, so conversations flow naturally.
//
// onNewMessage(regex) is the only chat-sdk hook that fires on
// unsubscribed threads without a mention. We match /.*/ and filter:
//   - Must be a Discord sub-thread (thread.id != thread.channelId),
//     otherwise we'd reply to every message in the allowed channel.
//   - Must be under the allowed parent channel.
//   - Skip mentions (onNewMention owns those; SDK may fire both).
//   - Skip self/bot messages.
chat.onNewMessage(/.*/, async (thread, message) => {
  if (message.author.isMe || message.author.isBot) return;
  if (message.isMention) return;
  if (thread.id === thread.channelId) return;
  if (!threadIsInAllowedChannel(thread)) return;

  log("event", "onNewMessage: auto-subscribing thread + handling", {
    threadId: thread.id,
    channelId: thread.channelId,
    authorId: message.author.id,
  });
  await thread.subscribe();
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
