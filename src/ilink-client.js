import { WeChatBot } from "@wechatbot/wechatbot";

/**
 * Create a configured WeChatBot instance.
 *
 * Uses file-based storage (default) to persist login credentials
 * so subsequent runs skip the QR code step automatically.
 */
export function createBot(options = {}) {
  return new WeChatBot({
    storage: "file",
    logLevel: "info",
    loginCallbacks: {
      onQrUrl: (url) => {
        console.log("📱 请扫描二维码绑定微信账号：");
        console.log(url);
      },
      onScanned: () => {
        console.log("✓ 已扫码，请在手机上确认登录...");
      },
    },
    ...options,
  });
}
