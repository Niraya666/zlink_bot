import { WeChatBot } from "@wechatbot/wechatbot";

/**
 * Create a configured WeChatBot instance.
 *
 * Uses file-based storage (default) to persist login credentials
 * so subsequent runs skip the QR code step automatically.
 */
export function createBot(options = {}) {
  // NOTE: WeChatBot ignores `loginCallbacks` here — pass QR login callbacks
  // to bot.run({ callbacks }) / bot.login({ callbacks }) instead.
  return new WeChatBot({
    storage: "file",
    logLevel: "info",
    ...options,
  });
}
