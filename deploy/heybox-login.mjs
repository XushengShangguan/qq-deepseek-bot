// Log her 小黑盒 account in by QR code and save the session cookies.
// Run on your own computer (it drives a headless browser), then copy the file
// to the server:
//
//   npm i --no-save playwright && npx playwright install chromium
//   node deploy/heybox-login.mjs data/heybox.json
//   scp data/heybox.json root@<server>:/opt/companion/data/heybox.json
//
// The QR code opens as an image; scan it with the 小黑盒 app logged in as HER
// account (not yours). Only the four cookies the API needs are kept.
import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const OUT = resolve(process.argv[2] || "data/heybox.json");
const SHOT = resolve(tmpdir(), "heybox-qrcode.png");
const WAIT_MS = 4 * 60 * 1000;
const KEEP = ["user_pkey", "user_heybox_id", "heybox_id", "x_xhh_tokenid"];

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto("https://login.xiaoheihe.cn/?origin=heybox&redirect_url=https%3A%2F%2Fwww.xiaoheihe.cn%2Fhome", {
    waitUntil: "networkidle",
  });
  // The QR panel sits behind a small toggle on the current layout.
  const toggle = await page.$(".login-code-form__qr-trigger");
  if (toggle) await toggle.click();
  const qr = await page.waitForSelector("canvas#login-qrcode", { timeout: 20_000 });
  // The canvas exists before the code is drawn on it; wait for dark pixels.
  await page.waitForFunction(
    () => {
      const c = document.querySelector("canvas#login-qrcode");
      if (!c || !c.width) return false;
      const px = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0 && px[i] < 100) return true;
      return false;
    },
    null,
    { timeout: 20_000 }
  );
  await qr.screenshot({ path: SHOT });
  if (process.platform === "darwin") execFile("open", [SHOT]);
  console.log(`二维码：${SHOT}\n用她的小黑盒号扫码（4 分钟内）…`);

  const deadline = Date.now() + WAIT_MS;
  let jar = {};
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    jar = Object.fromEntries(
      (await context.cookies())
        .filter((c) => c.domain.includes("xiaoheihe") && KEEP.includes(c.name))
        .map((c) => [c.name, c.value])
    );
    if (jar.user_pkey) break;
  }
  if (!jar.user_pkey) throw new Error("没等到扫码登录");
  if (!jar.heybox_id && jar.user_heybox_id) jar.heybox_id = jar.user_heybox_id;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify({ cookie: jar }, null, 2)}\n`, { mode: 0o600 });
  console.log(`登录成功，heybox_id=${jar.heybox_id}，已保存到 ${OUT}`);
} finally {
  await browser.close();
}
