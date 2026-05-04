(async () => {
  if (window.__yt2gInjected) return;
  window.__yt2gInjected = true;

  const log = (...a) => console.log("[YouTube → Gemini]", ...a);

  let prompt = null;
  try {
    const res = await chrome.runtime.sendMessage({ type: "consumePrompt" });
    prompt = res && res.prompt;
  } catch {}
  if (!prompt) return;
  log("准备发送:", prompt);

  await selectFastModel();

  const editor = await waitFor(findEditor, 30000);
  if (!editor) return log("未在 30s 内找到 Gemini 输入框。");

  insertText(editor, prompt);
  await sleep(300);

  const sendButton = await waitFor(findSendButton, 15000);
  if (!sendButton) return log("没找到发送按钮，放弃自动提交。");
  sendButton.click();

  const ok = await waitFor(() => isSubmitted(prompt), 8000);
  log(ok ? "✓ 已提交。" : "未观察到提交气泡，提交可能未生效。");

  // ---------- helpers ----------

  function findEditor() {
    return (
      document.querySelector('div.ql-editor[contenteditable="true"]') ||
      document.querySelector('rich-textarea div[contenteditable="true"]')
    );
  }

  function findSendButton() {
    const usable = (b) =>
      b &&
      !b.disabled &&
      b.getAttribute("aria-disabled") !== "true" &&
      b.offsetParent;
    const byClass = document.querySelector("button.send-button");
    if (usable(byClass)) return byClass;
    for (const b of document.querySelectorAll("button[aria-label]")) {
      if (!usable(b)) continue;
      const l = (b.getAttribute("aria-label") || "").trim().toLowerCase();
      if (
        l === "send message" ||
        l === "send" ||
        l === "发送" ||
        l === "发送消息" ||
        l === "傳送" ||
        l === "傳送訊息"
      ) {
        return b;
      }
    }
    return null;
  }

  function insertText(el, text) {
    el.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
    if (document.execCommand("insertText", false, text)) return;
    el.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = text;
    el.appendChild(p);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      })
    );
  }

  function isSubmitted(text) {
    const ed = findEditor();
    const editorEmpty = !ed || (ed.textContent || "").trim() === "";
    const bubble = Array.from(
      document.querySelectorAll(
        "user-query-content, .user-query-bubble-with-background, .query-text"
      )
    ).some((el) => (el.textContent || "").includes(text));
    return bubble || editorEmpty;
  }

  async function selectFastModel() {
    const trigger = await waitFor(findModelTrigger, 8000);
    if (!trigger) return log("没找到模型选择器，沿用默认。");
    if (/Fast|快速/i.test((trigger.textContent || "").trim())) {
      return log("已是 Fast 模型，跳过切换。");
    }
    trigger.click();
    await sleep(250);
    const opt = await waitFor(findFastOption, 3000);
    if (opt) {
      opt.click();
      log("已切换到 Fast 模型。");
    } else {
      log("打开了模型菜单但找不到 Fast 选项，沿用默认。");
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    }
    await sleep(250);
  }

  function findModelTrigger() {
    const cands = document.querySelectorAll(
      'bard-mode-switcher button, button[aria-haspopup="menu"], button[aria-haspopup="listbox"]'
    );
    for (const b of cands) {
      if (
        b.offsetParent &&
        /Fast|快速|Pro|Flash|Thinking/.test((b.textContent || "").trim())
      ) {
        return b;
      }
    }
    return null;
  }

  function findFastOption() {
    const opts = document.querySelectorAll(
      '[role="menuitem"], [role="option"], mat-option, button'
    );
    for (const o of opts) {
      const t = (o.textContent || "").trim();
      if (o.offsetParent && /^(Fast|快速)\b/.test(t)) return o;
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function waitFor(fn, timeout = 15000, interval = 200) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let r = null;
        try {
          r = fn();
        } catch {}
        if (r) return resolve(r);
        if (Date.now() - start >= timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }
})();
