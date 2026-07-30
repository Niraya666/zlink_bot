// B. SDK 层凭证隔离：两个实例各自独立 storageDir，互不覆盖，且不碰真实登录态。
import { fileURLToPath } from "node:url";
import path0 from "node:path";
const SDK = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), "..", "node_modules/@wechatbot/wechatbot/dist");
const { WeChatBot } = await import(`${SDK}/index.js`);
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const real = path.join(os.homedir(), ".wechatbot", "credentials.json");
const before = fs.readFileSync(real, "utf8");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zlink-dual-"));
const dirA = path.join(root, "bindA"), dirB = path.join(root, "bindB");

const botA = new WeChatBot({ storage: "file", storageDir: dirA, logLevel: "silent" });
const botB = new WeChatBot({ storage: "file", storageDir: dirB, logLevel: "silent" });

await botA.storage.set("credentials", { token: "AAA" });
await botB.storage.set("credentials", { token: "BBB" });
await botA.storage.set("cursor", { c: 1 });
await botB.storage.set("cursor", { c: 2 });

const ra = await botA.storage.get("credentials"), rb = await botB.storage.get("credentials");
const ca = await botA.storage.get("cursor"),      cb = await botB.storage.get("cursor");
console.log(`凭证互不覆盖:  A=${ra.token} B=${rb.token} → ${ra.token==="AAA" && rb.token==="BBB"}`);
console.log(`游标互不覆盖:  A=${ca.c} B=${cb.c} → ${ca.c===1 && cb.c===2}`);
console.log(`各自独立落盘:  bindA=[${fs.readdirSync(dirA)}]  bindB=[${fs.readdirSync(dirB)}]`);
console.log(`真实登录态未变: ${fs.readFileSync(real,"utf8") === before}`);
console.log(`两实例可共存:   ${botA !== botB && typeof botA.onMessage === "function" && typeof botB.onMessage === "function"}`);
fs.rmSync(root, { recursive: true, force: true });
