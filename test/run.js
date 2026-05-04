/* End-to-end test for the YouTube → Gemini extension.
 *
 * Strategy:
 *  - Launch the user's real Google Chrome via Playwright (persistent context),
 *    against a dedicated test profile dir so we never disturb the real one.
 *  - Load the unpacked extension.
 *  - Detect the extension's service worker, then *programmatically* invoke
 *    `self.handleMenuClick(...)` inside the service worker, which is the exact
 *    code path triggered by chrome.contextMenus.onClicked.
 *  - Watch for the new background tab to appear, then verify content.js
 *    succeeded by waiting for the prompt to show up as a *user* message in
 *    the Gemini conversation.
 *
 * If the test profile is not logged into Gemini yet, the script will pause
 * and let the user sign in interactively (the headed window stays open).
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const EXTENSION_DIR = path.resolve(__dirname, "..");
const PROFILE_DIR = process.env.YT2G_PROFILE_DIR || "/tmp/yt-gemini-test-profile";
// Default to Playwright's bundled Chromium for reliable --load-extension
// support; set CHROME_PATH=/Applications/Google\ Chrome.app/... to use your
// real Chrome (you'll then need to sign in once in the test profile).
const CHROME_PATH = process.env.CHROME_PATH || "";

// Allow override via env so we can also exercise the youtu.be normalization.
const TEST_VIDEO =
  process.env.YT2G_LINK || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
// Whatever URL we feed in, background.js normalizes youtu.be → www.youtube.com.
const NORMALIZED = TEST_VIDEO.startsWith("https://youtu.be/")
  ? `https://www.youtube.com/watch?v=${TEST_VIDEO.replace(
      /^https:\/\/youtu\.be\//,
      ""
    ).split(/[?#]/)[0]}`
  : TEST_VIDEO;
const EXPECTED_PROMPT = `总结视频 ${NORMALIZED}`;

function log(...args) {
  console.log("[test]", ...args);
}

async function waitForServiceWorker(context, { timeoutMs = 30000 } = {}) {
  const findExisting = () =>
    context
      .serviceWorkers()
      .find((sw) => sw.url().startsWith("chrome-extension://"));
  if (findExisting()) return findExisting();

  // Try to wake the SW by poking the extension via a normal page; we need its
  // id, which we can grab once any chrome-extension:// target shows up.
  const wakerPage = await context.newPage();
  const deadline = Date.now() + timeoutMs;
  let sw = null;
  while (!sw && Date.now() < deadline) {
    sw = findExisting();
    if (sw) break;
    // Poll Playwright targets via CDP for any chrome-extension URL.
    try {
      const session = await context.newCDPSession(wakerPage);
      const { targetInfos } = await session.send("Target.getTargets");
      const extTarget = targetInfos.find(
        (t) => t.url && t.url.startsWith("chrome-extension://")
      );
      await session.detach().catch(() => {});
      if (extTarget) {
        const id = new URL(extTarget.url).host;
        await wakerPage
          .goto(`chrome-extension://${id}/manifest.json`, { timeout: 5000 })
          .catch(() => {});
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  await wakerPage.close().catch(() => {});
  if (!sw) {
    throw new Error(
      "扩展 service worker 未在 " + timeoutMs + "ms 内出现；扩展可能没成功加载。"
    );
  }
  return sw;
}

async function isLoggedIntoGemini(context) {
  const page = await context.newPage();
  try {
    await page.goto("https://gemini.google.com/app", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(2500);
    const url = page.url();
    if (/accounts\.google\.com|signin|consent/i.test(url)) return false;
    // The logged-out landing page also renders an editor and a "Sign in"
    // button in the top-right. The reliable signal of a signed-in app is the
    // absence of that "Sign in" CTA *and* presence of an editor.
    const signedOut = await page
      .evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll("a, button, [role='button']")
        );
        return candidates.some((el) => {
          const t = (el.textContent || "").trim().toLowerCase();
          return t === "sign in" || t === "登录" || t === "登入";
        });
      })
      .catch(() => false);
    if (signedOut) return false;
    const editor = await page
      .locator(
        'div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"], [contenteditable="true"][role="textbox"]'
      )
      .first()
      .elementHandle({ timeout: 15000 })
      .catch(() => null);
    return !!editor;
  } finally {
    await page.close().catch(() => {});
  }
}

async function waitForLogin(context) {
  log("================================================================");
  log("👉 请在弹出的浏览器窗口里登录 Gemini：");
  log("   1. 在 https://gemini.google.com/app 页面右上角点 Sign in");
  log("   2. 用你的 Google 账号登录");
  log("   3. 看到对话主界面（左侧有历史、底部有输入框）即可");
  log("   登录态会持久化到 " + PROFILE_DIR + "，下次免登录。");
  log("   超时上限：10 分钟。");
  log("================================================================");
  const deadline = Date.now() + 10 * 60 * 1000;
  let elapsedTicks = 0;
  while (Date.now() < deadline) {
    if (await isLoggedIntoGemini(context)) {
      log("✓ 检测到已登录 Gemini。");
      return true;
    }
    elapsedTicks++;
    if (elapsedTicks % 6 === 0) {
      const minsLeft = Math.ceil((deadline - Date.now()) / 60000);
      log("…仍在等待登录（剩约 " + minsLeft + " 分钟）。");
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

async function run() {
  if (CHROME_PATH && !fs.existsSync(CHROME_PATH)) {
    throw new Error(`找不到 CHROME_PATH 指定的可执行文件: ${CHROME_PATH}`);
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const launchOpts = {
    headless: false,
    viewport: null,
    // Look like a regular Chrome to make Google's bot detector happy enough
    // to allow an interactive sign-in.
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
    ignoreDefaultArgs: ["--enable-automation"],
  };
  if (CHROME_PATH) {
    launchOpts.executablePath = CHROME_PATH;
    log("启动真实 Chrome:", CHROME_PATH);
  } else {
    log("启动 Playwright 自带 Chromium（如需用本地 Chrome：CHROME_PATH=...）");
  }
  log("Profile dir:", PROFILE_DIR);
  log("Extension dir:", EXTENSION_DIR);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);

  try {
    const sw = await waitForServiceWorker(context);
    const extensionId = new URL(sw.url()).host;
    log("扩展 service worker:", sw.url());
    log("Extension ID:", extensionId);

    if (!(await isLoggedIntoGemini(context))) {
      const ok = await waitForLogin(context);
      if (!ok) {
        throw new Error("登录 Gemini 超时，测试中止。");
      }
    } else {
      log("Gemini 已登录，直接进入测试。");
    }

    // ---- Phase A: 未登录场景 ----
    log("[Phase A] 把 isLoggedIn 打桩为 false，验证不开新 tab、返回 needsLogin。");
    const tabsBefore = context.pages().length;
    const phaseA = await sw.evaluate(async (linkUrl) => {
      const orig = self.isLoggedIn;
      self.isLoggedIn = async () => false;
      try {
        const r = await self.handleMenuClick(
          { menuItemId: "yt2g-link", linkUrl },
          undefined
        );
        return { ok: true, result: r };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      } finally {
        self.isLoggedIn = orig;
      }
    }, TEST_VIDEO);
    log("[Phase A] 返回:", JSON.stringify(phaseA));
    if (
      !phaseA.ok ||
      !phaseA.result ||
      phaseA.result.needsLogin !== true
    ) {
      throw new Error("[Phase A] 未登录路径没返回 needsLogin: " + JSON.stringify(phaseA));
    }
    await new Promise((r) => setTimeout(r, 1500));
    const tabsAfter = context.pages().length;
    if (tabsAfter !== tabsBefore) {
      throw new Error(
        "[Phase A] 未登录场景不应开新 tab，但 tab 数从 " +
          tabsBefore +
          " 变到 " +
          tabsAfter
      );
    }
    log("[Phase A] ✓ 未登录路径不开新 tab，仅返回 needsLogin。");

    // ---- Phase B: 已登录场景，真正的 e2e ----
    log("[Phase B] 调用真实 handleMenuClick，进入 e2e 主流程。");
    const newPagePromise = context.waitForEvent("page", { timeout: 30000 });

    const result = await sw.evaluate(async (linkUrl) => {
      const debug = {
        hasHandleMenuClick: typeof self.handleMenuClick,
        hasIsLoggedIn: typeof self.isLoggedIn,
        handleMenuClickSrcStart: (self.handleMenuClick || (() => {}))
          .toString()
          .slice(0, 120),
      };
      if (typeof self.handleMenuClick !== "function") {
        return { ok: false, error: "handleMenuClick 未在 SW 中", debug };
      }
      try {
        if (typeof self.isLoggedIn === "function") {
          debug.loggedIn = await self.isLoggedIn();
        }
      } catch (e) {
        debug.loggedInError = String((e && e.message) || e);
      }
      try {
        const r = await self.handleMenuClick(
          { menuItemId: "yt2g-link", linkUrl },
          undefined
        );
        return { ok: true, result: r, debug };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err), debug };
      }
    }, TEST_VIDEO);

    if (!result.ok) {
      throw new Error("handleMenuClick 调用失败: " + result.error);
    }
    log("handleMenuClick 返回:", JSON.stringify(result.result));
    log("debug:", JSON.stringify(result.debug));
    if (result.result && result.result.needsLogin) {
      throw new Error(
        "background 检测到未登录，但测试 profile 应当已登录 —— 请重新跑登录流程。"
      );
    }

    const newPage = await newPagePromise;
    newPage.on("console", (msg) => {
      const t = msg.text();
      if (t.includes("YouTube → Gemini") || t.includes("[YouTube")) {
        log("[gemini-tab]", msg.type(), t);
      }
    });
    newPage.on("pageerror", (err) => log("[gemini-tab pageerror]", err.message));
    log("观测到新 tab:", newPage.url());

    await newPage.waitForLoadState("domcontentloaded", { timeout: 60000 });
    log("等待 content script 把 prompt 写入并发送 …");

    const found = await newPage
      .waitForFunction(
        (text) => {
          const isInsideEditor = (el) =>
            !!el.closest(
              'rich-textarea, .ql-editor, [contenteditable="true"]'
            );
          const namedBubbles = Array.from(
            document.querySelectorAll(
              "user-query, user-query-content, .user-query-bubble-with-background, .query-text, [data-test-id='user-query']"
            )
          );
          if (
            namedBubbles.some(
              (el) =>
                !isInsideEditor(el) &&
                el.textContent &&
                el.textContent.includes(text)
            )
          ) {
            return true;
          }
          return Array.from(document.querySelectorAll("p, span, div")).some(
            (el) =>
              el.children.length === 0 &&
              !isInsideEditor(el) &&
              el.textContent &&
              el.textContent.trim() === text
          );
        },
        EXPECTED_PROMPT,
        { timeout: 90000, polling: 1000 }
      )
      .then(() => true)
      .catch(() => false);

    const screenshotPath = path.join(__dirname, "result.png");
    await newPage.screenshot({ path: screenshotPath, fullPage: false });
    log("截图保存到", screenshotPath);

    if (!found) {
      const editorPresent = await newPage
        .locator('div.ql-editor[contenteditable="true"]')
        .count()
        .catch(() => 0);
      const sendButtons = await newPage
        .locator(
          'button.send-button, button[aria-label*="send" i], button[aria-label*="发送"], button[aria-label*="傳送"]'
        )
        .count()
        .catch(() => 0);
      const consoleHits = await newPage
        .evaluate(() => {
          return {
            url: location.href,
            title: document.title,
            html: document.body ? document.body.innerText.slice(0, 1000) : null,
          };
        })
        .catch(() => null);
      throw new Error(
        "未在 90s 内观察到 prompt 被发送。诊断: editor=" +
          editorPresent +
          ", sendButtons=" +
          sendButtons +
          ", page=" +
          JSON.stringify(consoleHits)
      );
    }

    const modelLabel = await newPage
      .evaluate(() => {
        const cands = document.querySelectorAll(
          'bard-mode-switcher button, button[aria-haspopup="menu"], button[aria-haspopup="listbox"]'
        );
        for (const b of cands) {
          const t = (b.textContent || "").trim();
          if (b.offsetParent && /Fast|快速|Pro|Flash|Thinking/i.test(t)) {
            return t;
          }
        }
        return null;
      })
      .catch(() => null);
    log("当前模型选择器文本:", modelLabel || "(读不到)");
    if (modelLabel && !/Fast|快速/i.test(modelLabel)) {
      throw new Error("提交时模型未被切到 Fast，实际为: " + modelLabel);
    }

    log("✅ 端到端测试通过：prompt 已成功在 Gemini 对话中出现，模型为 Fast。");
  } finally {
    if (process.env.YT2G_KEEP_OPEN === "1") {
      log("YT2G_KEEP_OPEN=1，保留浏览器以便人工查看，按 Ctrl+C 退出。");
      await new Promise(() => {});
    }
    await context.close();
  }
}

run().catch((err) => {
  console.error("[test] FAILED:", err && err.stack ? err.stack : err);
  process.exit(1);
});
