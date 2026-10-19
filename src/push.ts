/**
 * The session's alert channel: how Powerline tells a host something it did not ask for
 * (a reminder at 08:00, the grid going off, the battery near the reserve).
 *
 * Preferred path — RESOURCE SUBSCRIPTIONS. Every alert is appended to the session's
 * `powerline://alerts` resource; a host that has subscribed to it (`resources/subscribe`)
 * gets `notifications/resources/updated` and reads the new entries. That notification is
 * current in protocol 2025-11-25 and maps onto the `resource_updated` event that 2026-07-28
 * carries over `subscriptions/listen`, so the channel is not tied to a deprecated feature.
 *
 * Fallback — MCP LOGGING (`notifications/message`). Deprecated as of 2026-07-28 (SEP-2577) but
 * functional through the deprecation window, and the only push many hosts render today. Used
 * only when the host has not subscribed. Every alert carries the same `id` on both paths, so a
 * host that subscribes later can skip what it already heard over logging.
 */
import { ResourceNotFoundError, type McpServer } from "@modelcontextprotocol/server";

export const ALERTS_URI = "powerline://alerts";
const KEEP = 20;

export interface AlertEntry { id: number; at: string; kind: string; text: string; [k: string]: unknown }

export interface AlertChannel {
  /** Deliver one alert to this session over the best channel the host supports. */
  send(kind: string, text: string, data?: Record<string, unknown>): Promise<void>;
  /** True once the host has subscribed to powerline://alerts. */
  readonly subscribed: boolean;
}

const channels = new WeakMap<McpServer, AlertChannel>();

/** The channel for a server created by createServer(); for anything else (tests that build bare servers), logging only. */
export function alertChannelFor(server: McpServer): AlertChannel {
  return channels.get(server) ?? { subscribed: false, send: async (kind, text, data = {}) => {
    await server.sendLoggingMessage({ level: "warning", logger: "powerline.alerts", data: { ...data, kind, text } });
  } };
}

/** Wire the alerts resource and the subscribe/unsubscribe handlers onto a new session's server. */
export function installAlertChannel(server: McpServer): AlertChannel {
  const recent: AlertEntry[] = [];
  let nextId = 1;
  let subscribed = false;

  server.registerResource("alerts", ALERTS_URI, {
    title: "Alerts",
    description: "The most recent alerts and reminders Powerline has pushed in this session, oldest first. Subscribe to be told when a new one arrives.",
    mimeType: "application/json",
  }, async () => ({ contents: [{ uri: ALERTS_URI, mimeType: "application/json", text: JSON.stringify({ alerts: recent }) }] }));

  // Only the alerts resource changes on its own; subscribing to anything else would succeed and never fire, so refuse it.
  server.server.setRequestHandler("resources/subscribe", async (req) => {
    if (req.params.uri !== ALERTS_URI) throw new ResourceNotFoundError(req.params.uri, `Only ${ALERTS_URI} can be subscribed to`);
    subscribed = true;
    return {};
  });
  server.server.setRequestHandler("resources/unsubscribe", async (req) => {
    if (req.params.uri === ALERTS_URI) subscribed = false;
    return {};
  });

  const channel: AlertChannel = {
    get subscribed() { return subscribed; },
    async send(kind, text, data = {}) {
      const entry: AlertEntry = { ...data, id: nextId++, at: new Date().toISOString(), kind, text };
      recent.push(entry);
      if (recent.length > KEEP) recent.splice(0, recent.length - KEEP);
      if (subscribed) await server.server.sendResourceUpdated({ uri: ALERTS_URI });
      else await server.sendLoggingMessage({ level: "warning", logger: "powerline.alerts", data: entry });
    },
  };
  channels.set(server, channel);
  return channel;
}
