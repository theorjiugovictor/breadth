// Takes the README / landing page screenshots with Playwright.
// Usage: node scripts/screenshots.mjs [url]   (default: a fresh `noodles serve` of the shop demo)
// Needs Playwright: `npm i -D playwright && npx playwright install chromium` (not a project dependency).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pw;
try {
  pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
} catch {
  console.error("Playwright is not installed: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}
const { chromium } = pw.default ?? pw;

let url = process.argv[2];
let server;
if (!url) {
  server = spawn(process.execPath, [join(root, "cli/dist/noodles.mjs"), "serve", "examples/shop/flowgraph.json", "--no-open", "--port", "4999"], { cwd: root, stdio: "ignore" });
  url = "http://127.0.0.1:4999/";
  await new Promise((r) => setTimeout(r, 1200));
}

const outDirs = [join(root, "docs/img"), join(root, "site/assets")];
for (const d of outDirs) mkdirSync(d, { recursive: true });

const browser = await chromium.launch();
async function shot(name, theme, steps) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.addInitScript((t) => localStorage.setItem("noodles-theme", t), theme);
  await page.goto(url);
  await page.waitForSelector(".react-flow__node");
  await page.waitForTimeout(1200);
  await steps(page);
  for (const d of outDirs) await page.screenshot({ path: join(d, `${name}.png`) });
  await page.close();
}

const dblclick = async (page, name) => {
  const box = await page.locator(".react-flow__node", { has: page.locator(".card-name", { hasText: new RegExp(`^${name}$`) }) }).first().boundingBox();
  await page.mouse.move(box.x + 60, box.y + 25);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await page.waitForTimeout(1200);
};

// Map: the shop's services
await shot("map", "light", async (page) => {
  await dblclick(page, "shop");
  await dblclick(page, "services/");
  await page.keyboard.press("Escape");
});
// Trace: replaying a checkout, inside the orders service
const trace = async (page) => {
  await page.getByRole("tab", { name: "Trace" }).click();
  await page.waitForTimeout(800);
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1500);
};
await shot("hero-light", "light", trace);
// Insights: the N+1 finding highlighted on the canvas
await shot("insights", "light", async (page) => {
  await page.getByRole("tab", { name: /Insights/ }).click();
  await page.waitForTimeout(300);
  await page.locator(".insight", { hasText: "calls get_price in a loop" }).first().click();
  await page.waitForTimeout(1800);
});
await shot("hero-dark", "dark", trace);

await browser.close();
server?.kill();
console.log("screenshots written to docs/img and site/assets");
