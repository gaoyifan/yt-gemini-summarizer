(async () => {
  if (window.__yt2gInjected) return;
  window.__yt2gInjected = true;

  const log = (...a) => console.log("[YouTube → Gemini]", ...a);

  // 模型偏好，按优先级：先 Flash，Flash 不可用（比如未登录时被锁定）才退回 Flash-Lite，
  // 最后是旧版 UI 里的 “快速 / Fast”。注意 “Flash-Lite” 也包含 “Flash”，所以第一项要排除它。
  const MODEL_PREFERENCE = [
    /\bFlash\b(?!-Lite)/i,
    /Flash-Lite|Fastest|极速|極速/i,
    /^(?:快速|Fast)/i
  ];

  let prompt = null;
  try {
    const res = await chrome.runtime.sendMessage({ type: "consumePrompt" });
    prompt = res && res.prompt;
  } catch {}
  if (!prompt) return;
  log("准备发送:", prompt);

  await selectModel();

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
    const btn = firstVisible("gem-icon-button.send-button button");
    return btn && !isDisabled(btn) ? btn : null;
  }

  function insertText(el, text) {
    el.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
    // execCommand 会走浏览器原生的编辑流程，自带 beforeinput / input 事件，Quill 能直接感知。
    // 在真实的隐藏后台标签页（visibilityState=hidden、无焦点）里实测也返回 true。
    document.execCommand("insertText", false, text);
  }

  function isSubmitted(text) {
    return Array.from(
      document.querySelectorAll(
        "user-query-content, .user-query-bubble-with-background, .query-text"
      )
    ).some((el) => (el.textContent || "").includes(text));
  }

  // 打开模型菜单，按 MODEL_PREFERENCE 点选一项。是否已选中看菜单项自己的 aria-checked。
  async function selectModel() {
    // 实测选择器通常 3–6 秒出现，约 1/12 的加载要 10–12 秒，所以给足 20 秒。
    const trigger = await waitFor(findModelTrigger, 20000);
    if (!trigger) return log("没找到模型选择器，沿用默认。");

    trigger.click();
    await waitFor(findModelItems, 3000);
    await sleep(250); // 等菜单项的锁定/可用状态渲染完，再决定选哪个
    const target = choosePreferred(findModelItems() || []);
    if (!target) {
      log("打开了模型菜单但找不到可用的 Flash / Flash-Lite 选项，沿用默认。");
      trigger.click(); // 再点一次收起菜单
      return;
    }

    const alreadySelected = target.getAttribute("aria-checked") === "true";
    target.click(); // 点已选中的项也会收起菜单
    log(alreadySelected ? "已是目标模型:" : "已切换到:", normalText(target));
    await sleep(250);
  }

  function findModelTrigger() {
    return firstVisible(
      'button[data-test-id="bard-mode-menu-button"], bard-mode-switcher button[aria-haspopup]'
    );
  }

  function findModelItems() {
    const items = Array.from(
      document.querySelectorAll(
        '[role="menu"] [role^="menuitem"], [role="listbox"] [role="option"], [data-test-id^="bard-mode-option-"]'
      )
    ).filter(isVisible);
    return items.length ? items : null;
  }

  function choosePreferred(items) {
    // 当前 UI 的模型项是 role=menuitemradio；“Sign in …”这类推广项只是普通 menuitem，
    // 文案可能带 “Flash”（点了会跳去登录）。所以有 radio 项时只在 radio 项里选，
    // 没有 radio 项（旧版菜单）才在所有菜单项里选。
    const radios = items.filter((el) => el.getAttribute("role") === "menuitemradio");
    const usable = (radios.length ? radios : items).filter((el) => !isDisabled(el));
    for (const pattern of MODEL_PREFERENCE) {
      const hit = usable.find((el) => pattern.test(normalText(el)));
      if (hit) return hit;
    }
    return null;
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
