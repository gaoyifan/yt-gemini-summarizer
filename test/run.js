/* End-to-end test for the YouTube -> Gemini extension.
 *
 * The extension no longer checks Gemini login state. The test verifies the core
 * flow only: background opens Gemini, content.js selects the fast model,
 * submits prompt,
 * and the prompt appears as a user message.
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const EXTENSION_DIR = path.resolve(__dirname, "..");
const PROFILE_DIR = process.env.YT2G_PROFILE_DIR || "/tmp/yt-gemini-test-profile";
const CHROME_PATH = process.env.CHROME_PATH || "";
const TEST_VIDEO =
  process.env.YT2G_LINK || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const EXPECTED_URL = TEST_VIDEO.startsWith("https://youtu.be/")
  ? `https://www.youtube.com/watch?v=${TEST_VIDEO.replace(
      /^https:\/\/youtu\.be\//,
      ""
    ).split(/[?#]/)[0]}`
  : TEST_VIDEO;
const EXPECTED_PROMPT = `总结视频 ${EXPECTED_URL}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log("[test]", ...args);

async function waitForServiceWorker(context, timeoutMs = 30000, extensionId = null) {
  const existing = () =>
    context
      .serviceWorkers()
      .find((sw) => sw.url().startsWith("chrome-extension://"));
  if (existing()) return existing();

  const page = await context.newPage();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const sw = existing();
      if (sw) return sw;
      if (extensionId) {
        await page
          .goto(`chrome-extension://${extensionId}/manifest.json`)
          .catch(() => {});
      }
      const target = await extensionTarget(context, page).catch(() => null);
      if (target) {
        const id = new URL(target.url).host;
        await page.goto(`chrome-extension://${id}/manifest.json`).catch(() => {});
      }
      await sleep(500);
    }
  } finally {
    await page.close().catch(() => {});
  }
  throw new Error(`扩展 service worker 未在 ${timeoutMs}ms 内出现。`);
}

async function reloadExtensionIfNeeded(context, sw) {
  const current = await sw
    .evaluate(() => ({
      hasApi: Boolean(self.__yt2gTest && self.__yt2gTest.handleMenuClick),
      version: chrome.runtime.getManifest().version,
    }))
    .catch(() => ({ hasApi: false, version: null }));
  const expectedVersion = JSON.parse(
    fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8")
  ).version;
  const freshEnough = current.hasApi && current.version === expectedVersion;
  if (freshEnough) return sw;

  log(
    `检测到旧版 service worker（当前 ${current.version || "unknown"}，期望 ${expectedVersion}），主动 reload 扩展。`
  );
  const extensionId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await sleep(1500);

  const fresh = context
    .serviceWorkers()
    .find((worker) => worker.url().startsWith("chrome-extension://"));
  if (!fresh) return waitForServiceWorker(context, 30000, extensionId);
  return fresh;
}

async function extensionTarget(context, page) {
  const session = await context.newCDPSession(page);
  try {
    const { targetInfos } = await session.send("Target.getTargets");
    return targetInfos.find(
      (target) => target.url && target.url.startsWith("chrome-extension://")
    );
  } finally {
    await session.detach().catch(() => {});
  }
}

async function runHappyPath(sw, context) {
  log("运行 e2e：打开后台 Gemini tab 并提交 prompt。");
  const pagePromise = context.waitForEvent("page", { timeout: 30000 });
  const result = await sw.evaluate(async (linkUrl) => {
    const api = self.__yt2gTest;
    if (!api || typeof api.handleMenuClick !== "function") {
      return { ok: false, error: "__yt2gTest.handleMenuClick 不存在" };
    }
    try {
      return { ok: true, result: await api.handleMenuClick({ linkUrl }, undefined) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }, TEST_VIDEO);

  if (!result.ok) throw new Error(`handleMenuClick 调用失败: ${result.error}`);
  log("handleMenuClick 返回:", JSON.stringify(result.result));

  const page = await pagePromise;
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("YouTube → Gemini")) log("[gemini-tab]", msg.type(), text);
  });
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  const submitted = await waitForUserBubble(page, EXPECTED_PROMPT);
  const screenshotPath = path.join(__dirname, "result.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });
  log("截图保存到", screenshotPath);
  if (!submitted) throw new Error("未观察到真实 user-query 气泡。");

  const model = await currentModelLabel(page);
  log("当前模型选择器文本:", model || "(读不到)");
  if (!model || !/Fast|快速|Flash/i.test(model)) {
    throw new Error(`提交时模型不是快速/Flash，实际为: ${model || "(读不到)"}`);
  }
  log("端到端测试通过：prompt 已提交，模型为快速/Flash。");
}

async function waitForUserBubble(page, prompt) {
  return page
    .waitForFunction(
      (text) => {
        const insideEditor = (el) =>
          Boolean(el.closest('rich-textarea, .ql-editor, [contenteditable="true"]'));
        return Array.from(
          document.querySelectorAll(
            "user-query, user-query-content, .user-query-bubble-with-background, .query-text"
          )
        ).some(
          (el) => !insideEditor(el) && (el.textContent || "").includes(text)
        );
      },
      prompt,
      { timeout: 90000, polling: 1000 }
    )
    .then(() => true)
    .catch(() => false);
}

async function currentModelLabel(page) {
  return page
    .evaluate(() => {
      for (const btn of document.querySelectorAll(
        'bard-mode-switcher button, button[aria-haspopup="menu"], button[aria-haspopup="listbox"]'
      )) {
        const text = (btn.textContent || "").trim();
        if (btn.offsetParent && /Fast|快速|Pro|Flash|Thinking/i.test(text)) {
          return text;
        }
      }
      return null;
    })
    .catch(() => null);
}

async function run() {
  if (CHROME_PATH && !fs.existsSync(CHROME_PATH)) {
    throw new Error(`找不到 CHROME_PATH 指定的可执行文件: ${CHROME_PATH}`);
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions());

  try {
    let sw = await waitForServiceWorker(context);
    sw = await reloadExtensionIfNeeded(context, sw);
    log("扩展 service worker:", sw.url());
    await runHappyPath(sw, context);
  } finally {
    if (process.env.YT2G_KEEP_OPEN === "1") {
      log("YT2G_KEEP_OPEN=1，保留浏览器以便人工查看，按 Ctrl+C 退出。");
      await new Promise(() => {});
    }
    await context.close();
  }
}

function launchOptions() {
  const opts = {
    headless: false,
    viewport: null,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation", "--disable-extensions"],
  };
  if (CHROME_PATH) opts.executablePath = CHROME_PATH;
  return opts;
}

run().catch((err) => {
  console.error("[test] FAILED:", err && err.stack ? err.stack : err);
  process.exit(1);
});
