// When 小黑盒 wants a captcha from her account: open a real browser window,
// logged in as her, on the page that asks for it, so a person can solve it.
// Run on your own computer; the server's copy of her login is fetched for the
// session and deleted afterwards.
//
//   npm i --no-save playwright && npx playwright install chromium
//   node deploy/heybox-verify.mjs root@<server> [post id]
//
// Then, if it worked, clear her pause (see docs/使用手册.md).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const server = process.argv[2];
const post = process.argv[3];
if (!server) {
  console.error("用法：node deploy/heybox-verify.mjs root@服务器IP [帖子号]");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "heybox-verify-"));
const file = join(dir, "heybox.json");
try {
  execFileSync("scp", ["-q", `${server}:/opt/companion/data/heybox.json`, file]);
  const jar = JSON.parse(readFileSync(file, "utf8")).cookie;

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(
    Object.entries(jar).map(([name, value]) => ({ name, value, domain: ".xiaoheihe.cn", path: "/" }))
  );
  const page = await context.newPage();
  await page.goto(post ? `https://www.xiaoheihe.cn/app/bbs/link/${post}` : "https://www.xiaoheihe.cn/home");
  console.log("浏览器已打开，登录的是她的号。有验证就完成它；没有就随便点开几个帖子。弄完关掉窗口。");
  await new Promise((resolve) => browser.on("disconnected", resolve));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
