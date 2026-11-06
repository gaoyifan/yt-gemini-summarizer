(async () => {
  if (window.__yt2gInjected) return;
  window.__yt2gInjected = true;

  const log = (...a) => console.log("[YouTube → Gemini]", ...a);
  // 匹配 "Flash"，但不匹配 "Flash-Lite"。
  const PLAIN_FLASH_RE = /\bFlash\b(?!-)/i;

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
    return document.querySelector('div.ql-editor[contenteditable="true"]');
  }

  function findSendButton() {
    const selectors = [
      "button.send-button",
      'gem-icon-button.send-button button',
      'button[aria-label="发送"]',
      'button[aria-label="Send"]'
    ];
    for (const selector of selectors) {
      const btn = firstVisible(selector);
      if (btn && !isDisabled(btn)) return btn;
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
    if (document.execCommand("insertText", false, text)) {
      fireTextInput(el, text);
      return;
    }
    el.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = text;
    el.appendChild(p);
    fireTextInput(el, text);
  }

  function fireTextInput(el, text) {
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      })
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isSubmitted(text) {
    return Array.from(
      document.querySelectorAll(
        "user-query-content, .user-query-bubble-with-background, .query-text"
      )
    ).some((el) => (el.textContent || "").includes(text));
  }

  async function selectFastModel() {
    const trigger = await waitFor(findModelTrigger, 8000);
    if (!trigger) return log("没找到模型选择器，沿用默认。");
    const current = normalText(trigger);
    if (PLAIN_FLASH_RE.test(current) || /^(?:快速|Fast)(?:\s|$)/i.test(current)) {
      return log("已是 Flash 模型，跳过切换。");
    }
    trigger.click();
    await sleep(250);
    const opt = await waitFor(findFastOption, 3000);
    if (opt) {
      opt.click();
      log("已切换到 Flash（或备选 Flash-Lite）模型。");
    } else {
      log("打开了模型菜单但找不到快速/Flash 选项，沿用默认。");
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    }
    await sleep(250);
  }

  function findModelTrigger() {
    const stable = firstVisible(
      'button[data-test-id="bard-mode-menu-button"]'
    );
    if (stable) return stable;

    const cands = Array.from(
      document.querySelectorAll(
        'bard-mode-switcher button[aria-haspopup="menu"], bard-mode-switcher button[aria-haspopup="listbox"], button[aria-label*="模式选择器"], button[aria-label*="mode"]'
      )
    ).filter(isVisible);

    const nearInput = cands.find((b) =>
      b.closest(".model-picker-container, .input-area, rich-textarea")
    );
    if (nearInput) return nearInput;

    for (const b of cands) {
      if (/Fast|快速|Pro|Flash|Thinking/i.test(normalText(b))) {
        return b;
      }
    }
    return null;
  }

  function findFastOption() {
    const exact = firstVisible(
      '[data-test-id="bard-mode-option-快速"], [data-test-id="bard-mode-option-Fast"]'
    );
    if (exact && !isDisabled(exact)) return exact;

    // 菜单不一定在 .cdk-overlay-container 里（新版在 bard-mode-switcher 内的
    // .cdk-overlay-popover 中），所以直接在整个文档里找菜单项。
    const menuItems = Array.from(
      document.querySelectorAll(
        '[role="menuitemradio"], [role="menuitem"], [role="option"], mat-option'
      )
    ).filter(
      (o) =>
        isVisible(o) &&
        !isDisabled(o) &&
        !/sign-in/i.test(o.getAttribute("data-test-id") || "") &&
        (o.closest(
          ".cdk-overlay-container, .cdk-overlay-popover, .cdk-overlay-pane, bard-mode-switcher"
        ) ||
          /^bard-mode-option/.test(o.getAttribute("data-test-id") || ""))
    );

    const match = (re) => menuItems.find((o) => re.test(normalText(o)));
    // 优先 Flash，备选 Flash-Lite，最后旧版的“快速/Fast”。
    return (
      match(PLAIN_FLASH_RE) ||
      match(/Flash-Lite|极速回答/i) ||
      match(/^(?:快速|Fast)(?:\s|$)/i) ||
      null
    );
  }

  function firstVisible(selector) {
    return Array.from(document.querySelectorAll(selector)).find(isVisible) || null;
  }

  function isVisible(el) {
    return Boolean(
      el &&
        el.getClientRects().length &&
        getComputedStyle(el).visibility !== "hidden"
    );
  }

  function isDisabled(el) {
    return Boolean(
      el &&
        (el.disabled ||
          el.getAttribute("aria-disabled") === "true" ||
          el.closest('[aria-disabled="true"]'))
    );
  }

  function normalText(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
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
