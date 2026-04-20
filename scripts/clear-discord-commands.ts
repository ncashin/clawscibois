#!/usr/bin/env bun
// Wipe all global + guild-scoped slash commands for the Discord bot.
// Useful when commands are stuck from previous registrations.
//
// Env: DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID (required),
//      DISCORD_GUILD_ID (optional; clears only global if unset).
// Flag: --dry-run lists without deleting.

const API = "https://discord.com/api/v10";

const TOKEN = process.env.DISCORD_BOT_TOKEN?.trim();
const APP_ID = process.env.DISCORD_APPLICATION_ID?.trim();
const GUILD_ID = process.env.DISCORD_GUILD_ID?.trim() || null;

if (!TOKEN || !APP_ID) {
  console.error(
    "error: DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID must be set",
  );
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");

const headers = {
  Authorization: `Bot ${TOKEN}`,
  "Content-Type": "application/json",
};

type Command = {
  id: string;
  name: string;
  type?: number;
  description?: string;
};

async function listCommands(scope: string, url: string): Promise<Command[]> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[${scope}] list failed: ${res.status} ${res.statusText} ${body}`,
    );
  }
  return (await res.json()) as Command[];
}

async function clear(scope: string, url: string): Promise<void> {
  const existing = await listCommands(scope, url);
  if (existing.length === 0) {
    console.log(`[${scope}] already empty (0 commands)`);
    return;
  }

  console.log(`[${scope}] ${existing.length} command(s):`);
  for (const c of existing) {
    console.log(`  - ${c.name} (${c.id})`);
  }

  if (dryRun) {
    console.log(`[${scope}] dry-run, not deleting`);
    return;
  }

  // PUT [] is Discord's documented atomic "delete all" for the scope.
  // https://discord.com/developers/docs/interactions/application-commands#bulk-overwrite-global-application-commands
  const res = await fetch(url, {
    method: "PUT",
    headers,
    body: "[]",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[${scope}] bulk-overwrite failed: ${res.status} ${res.statusText} ${body}`,
    );
  }

  const after = await listCommands(scope, url);
  if (after.length === 0) {
    console.log(`[${scope}] cleared - 0 commands remain`);
  } else {
    console.warn(
      `[${scope}] WARN: bulk-overwrite returned 2xx but ${after.length} command(s) remain`,
    );
  }
}

async function main(): Promise<void> {
  console.log(
    `clear-discord-commands (application=${APP_ID}, guild=${GUILD_ID ?? "<unset>"}${dryRun ? ", dry-run" : ""})`,
  );

  await clear("global", `${API}/applications/${APP_ID}/commands`);

  if (GUILD_ID) {
    await clear(
      "guild",
      `${API}/applications/${APP_ID}/guilds/${GUILD_ID}/commands`,
    );
  } else {
    console.log("[guild] skipped (DISCORD_GUILD_ID not set)");
  }

  console.log("done");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
