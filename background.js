const GEMINI_URL = "https://gemini.google.com/app";
const YT_URL_PATTERNS = [
  "*://*.youtube.com/watch*",
  "*://*.youtube.com/shorts/*",
  "*://youtu.be/*"
];

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "yt2g-link",
      title: "用 Gemini 总结此 YouTube 视频",
      contexts: ["link"],
      targetUrlPatterns: YT_URL_PATTERNS
    });
    chrome.contextMenus.create({
      id: "yt2g-page",
      title: "用 Gemini 总结当前 YouTube 视频",
      contexts: ["page"],
      documentUrlPatterns: YT_URL_PATTERNS
    });
  });
}
chrome.runtime.onInstalled.addListener(setupMenus);
chrome.runtime.onStartup.addListener(setupMenus);

function youtubeUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
  } catch {}
  return raw;
}

async function isLoggedIn() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(GEMINI_URL, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      signal: ctl.signal
    });
    clearTimeout(timer);
    return !/accounts\.google\.com|\/signin/i.test(res.url);
  } catch {
    return true;
  }
}

async function notifyLoginRequired(tabId) {
  if (typeof tabId !== "number") return;
  await chrome.scripting
    .executeScript({
      target: { tabId },
      func: () =>
        alert(
          "请先在浏览器里登录 Gemini（https://gemini.google.com）后再使用此功能。"
        )
    })
    .catch(() => {});
}

async function handleMenuClick(info, tab) {
  const url = youtubeUrl(info.linkUrl || info.pageUrl || "");
  if (!url) return null;

  if (!(await isLoggedIn())) {
    await notifyLoginRequired(tab && tab.id);
    return { needsLogin: true };
  }

  const newTab = await chrome.tabs.create({ url: GEMINI_URL, active: false });
  const prompt = `总结视频 ${url}`;
  await chrome.storage.session.set({ [`prompt:${newTab.id}`]: prompt });
  return { tabId: newTab.id, prompt };
}

// Exposed on `self` so the e2e test can invoke / stub them in the SW context.
self.handleMenuClick = handleMenuClick;
self.isLoggedIn = isLoggedIn;

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleMenuClick(info, tab).catch((e) =>
    console.error("[YouTube → Gemini]", e)
  );
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "consumePrompt" || !sender.tab) return undefined;
  const key = `prompt:${sender.tab.id}`;
  chrome.storage.session
    .get(key)
    .then((data) => {
      const prompt = data[key] || null;
      if (prompt) chrome.storage.session.remove(key);
      sendResponse({ prompt });
    })
    .catch(() => sendResponse({ prompt: null }));
  return true;
});
