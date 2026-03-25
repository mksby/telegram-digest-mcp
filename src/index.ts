import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { XMLParser } from "fast-xml-parser";

interface Env {
	TELEGRAM_CHANNELS: string;
	RSSHUB_BASE: string;
	API_TOKEN: string;
}

interface FeedItem {
	channel: string;
	title: string;
	content: string;
	link: string;
	pubDate: string;
}

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	processEntities: false
});

function stripHtml(html: string): string {
	return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

async function fetchFeed(base: string, channel: string): Promise<FeedItem[]> {
	const url = `${base}/telegram/channel/${channel}`;
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": "TelegramDigestMCP/1.0" },
			cf: { cacheTtl: 1800, cacheEverything: true },
		});
		if (!res.ok) return [];
		const xml = await res.text();
		const parsed = xmlParser.parse(xml);
		const items = parsed?.rss?.channel?.item ?? [];
		return (Array.isArray(items) ? items : [items]).map((item: any) => ({
			channel,
			title: item.title ?? "",
			content: stripHtml(item.description ?? ""),
			link: item.link ?? "",
			pubDate: item.pubDate ?? "",
		}));
	} catch {
		return [];
	}
}

async function getMessagesSince(env: Env, since?: string): Promise<FeedItem[]> {
	const channels = env.TELEGRAM_CHANNELS.split(",").map((c) => c.trim());
	const cutoff = since
		? new Date(since)
		: new Date(Date.now() - 24 * 60 * 60 * 1000);

	const feeds = await Promise.all(
		channels.map((ch) => fetchFeed(env.RSSHUB_BASE, ch))
	);

	return feeds
		.flat()
		.filter((item) => new Date(item.pubDate) > cutoff)
		.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
}

function getChannels(env: Env): string[] {
	return env.TELEGRAM_CHANNELS.split(",").map((c) => c.trim());
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function unauthorized(): Response {
	return json({ error: "Unauthorized" }, 401);
}

function checkAuth(request: Request, env: Env): boolean {
	return request.headers.get("Authorization") === `Bearer ${env.API_TOKEN}`;
}

export class TelegramDigestMCP extends McpAgent {
	server = new McpServer({
		name: "telegram-digest",
		version: "1.0.0",
	});

	async init() {
		this.server.tool(
			"get_channels",
			"List tracked Telegram channels",
			{},
			async () => ({
				content: [{ type: "text" as const, text: JSON.stringify(getChannels(this.env), null, 2) }],
			})
		);

		this.server.tool(
			"get_messages_since",
			"Get messages from tracked channels, defaults to last 24h",
			{
				since: z.string().optional().describe("ISO 8601 datetime cutoff"),
			},
			async ({ since }) => ({
				content: [
					{ type: "text" as const, text: JSON.stringify(await getMessagesSince(this.env, since), null, 2) },
				],
			})
		);

		this.server.tool(
			"get_channel_messages",
			"Get messages from a specific channel",
			{
				channel: z.string().describe("Channel username without @"),
				since: z.string().optional().describe("ISO 8601 datetime cutoff"),
			},
			async ({ channel, since }) => {
				const cutoff = since
					? new Date(since)
					: new Date(Date.now() - 24 * 60 * 60 * 1000);
				const items = await fetchFeed(this.env.RSSHUB_BASE, channel);
				const filtered = items.filter((i) => new Date(i.pubDate) > cutoff);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }],
				};
			}
		);
	}
}

const mcpHandler = TelegramDigestMCP.serve("/mcp");

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === "/mcp" || path === "/sse" || path.startsWith("/mcp/")) {
			return mcpHandler.fetch(request, env, ctx);
		}

		if (path === "/health") {
			return json({ status: "ok" });
		}

		if (path.startsWith("/api/")) {
			if (!checkAuth(request, env)) return unauthorized();

			if (path === "/api/channels") {
				return json({ channels: getChannels(env) });
			}

			if (path === "/api/digest") {
				const since = url.searchParams.get("since") ?? undefined;
				const messages = await getMessagesSince(env, since);
				return json({ count: messages.length, since: since ?? "last 24h", messages });
			}

			if (path.startsWith("/api/channel/")) {
				const channel = path.split("/api/channel/")[1];
				const since = url.searchParams.get("since") ?? undefined;
				const cutoff = since
					? new Date(since)
					: new Date(Date.now() - 24 * 60 * 60 * 1000);
				const items = await fetchFeed(env.RSSHUB_BASE, channel);
				const filtered = items.filter((i) => new Date(i.pubDate) > cutoff);
				return json({ channel, count: filtered.length, messages: filtered });
			}
		}

		return new Response("Not found", { status: 404 });
	},
};