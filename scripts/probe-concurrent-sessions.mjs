// A. 两个会话能否并发存活：状态接口是长轮询（单次可挂 ~45s），按其节奏观察。
import { fileURLToPath } from "node:url";
import path0 from "node:path";
const SDK = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), "..", "node_modules/@wechatbot/wechatbot/dist");
const { ILinkApi } = await import(`${SDK}/protocol/api.js`);
const { HttpClient } = await import(`${SDK}/transport/http.js`);
const { createLogger } = await import(`${SDK}/logger/index.js`);
const BASE = "https://ilinkai.weixin.qq.com";
const api = new ILinkApi(new HttpClient({ logger: createLogger({ level: "error" }) }));
const t0 = Date.now(), el = () => ((Date.now()-t0)/1000).toFixed(0).padStart(3);

const probe = async (qr, tag) => {
  const s = Date.now();
  try {
    const r = await api.pollQrStatus(BASE, qr);
    return `${tag}=${r.status}(${((Date.now()-s)/1000).toFixed(0)}s)`;
  } catch (e) {
    return `${tag}=挂起超时(${((Date.now()-s)/1000).toFixed(0)}s)`;
  }
};

const [a, b] = await Promise.all([api.getQrCode(BASE, []), api.getQrCode(BASE, [])]);
const tk = u => new URL(u).searchParams.get("qrcode");
console.log(`并发签发成功，两个 token 不同: ${tk(a.qrcode_img_content) !== tk(b.qrcode_img_content)}`);
console.log(`  A=${tk(a.qrcode_img_content)}`);
console.log(`  B=${tk(b.qrcode_img_content)}`);
console.log(`\n同时轮询两者（关注是否有一方被顶掉/立即失效）:`);
for (let i = 0; i < 4; i++) {
  const r = await Promise.all([probe(a.qrcode, "A"), probe(b.qrcode, "B")]);
  console.log(`  +${el()}s  ${r.join("   ")}`);
  if (r.every(x => x.includes("expired"))) { console.log("\n两者同时过期 → 生命周期各自独立、互不干扰"); break; }
}
console.log("\n结论：若全程 A、B 都未出现「一方 expired 而另一方仍 wait 之外的异常」，则服务端允许并发会话。");
