/* 模型选择的确定性测试。
 *
 * 真实 Gemini 页面里，“从别的模型切到 Flash” 这条路径很难靠 e2e 触发（新对话默认
 * 就是 Flash，没法区分“选中了”和“什么都没做”）。这里用最小 DOM 夹具来跑真实的
 * content.js：DOM 的结构和属性取自真实 Gemini 页面（gem-menu-item、menuitemradio、
 * aria-checked、锁定项的 aria-disabled），断言最终选中了哪一项，并且绝不点击锁定项。
 *
 * 用法：cd test && node model-selection.js
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const CONTENT_JS = fs.readFileSync(path.resolve(__dirname, "../content.js"), "utf8");

const M = {
  lite: ["3.5 Flash-Lite", "极速回答"],
  flash: ["3.8 Flash", "全方位帮助"],
  pro: ["3.1 Pro", "高级推理"],
  argon: ["4 Argon", "复杂任务"],
};

const scenarios = [
  {
    name: "已登录，当前 Flash-Lite → 切到 Flash",
    items: [M.lite, M.flash, M.pro, M.argon],
    current: "lite",
    expect: "3.8 Flash",
  },
  {
    name: "已登录，当前 Pro → 切到 Flash",
    items: [M.lite, M.flash, M.pro, M.argon],
    current: "pro",
    expect: "3.8 Flash",
  },
  {
    name: "已登录，当前已是 Flash → 保持 Flash（不会误选 Flash-Lite）",
    items: [M.lite, M.flash, M.pro, M.argon],
    current: "flash",
    expect: "3.8 Flash",
  },
  {
    name: "未登录，Flash 被锁定 → 退回 Flash-Lite，且不点锁定项",
    items: [M.lite, M.flash, M.pro, M.argon],
    current: "lite",
    locked: ["3.8 Flash", "3.1 Pro", "4 Argon"],
    signIn: ["Sign in", "Get more access"],
    expect: "3.5 Flash-Lite",
  },
  {
    // 真实页面里出现过的另一种推广文案：文字里带 “Flash”，但它是个普通 menuitem，不是模型。
    // 点它会跳去登录，prompt 就发不出去了。
    name: "未登录，登录推广项的文案里带 Flash → 仍选 Flash-Lite，不点推广项",
    items: [M.lite, M.flash, M.pro, M.argon],
    current: "lite",
    locked: ["3.8 Flash", "3.1 Pro", "4 Argon"],
    signIn: ["Sign in for all models", "Try the latest Flash"],
    expect: "3.5 Flash-Lite",
  },
  {
    name: "没有 Flash、只有 Pro 和 Lite → 选 Flash-Lite",
    items: [M.lite, M.pro],
    current: "pro",
    expect: "3.5 Flash-Lite",
  },
  {
    // 旧版 UI 已经看不到了，不知道标题和副标题之间有没有空白，所以用 compact 把空白去掉。
    name: "旧版菜单（快速 / 思考 / Pro）→ 选 快速",
    items: [["快速", "快速解答"], ["思考", "解决复杂问题"], ["Pro", "高级数学和代码"]],
    current: "思考",
    compact: true,
    expect: "快速",
  },
  {
    name: "旧版英文菜单（Fast / Thinking / Pro）→ 选 Fast",
    items: [["Fast", "Answers quickly"], ["Thinking", "Solves complex problems"], ["Pro", "Advanced math and code"]],
    current: "Thinking",
    compact: true,
    expect: "Fast",
  },
];

// 在页面里搭夹具：输入框、模型选择器（点击展开菜单）、发送按钮、用户气泡。
// 结构照抄真实 Gemini：菜单是 bard-mode-switcher 里的 div.cdk-overlay-popover >
// div.cdk-overlay-pane > … > gem-menu[role=menu] > gem-menu-item[role=menuitemradio]，
// 菜单项带 data-mode-id / data-test-id（锁定项的哈希是空的），标题和副标题之间有空白。
function installFixture({ items, currentLabel, locked, compact, signIn }) {
  document.body.innerHTML = `
    <div class="ql-editor" contenteditable="true"></div>
    <bard-mode-switcher>
      <button data-test-id="bard-mode-menu-button" aria-haspopup="true"></button>
      <div class="cdk-overlay-popover" popover="manual"><div class="cdk-overlay-pane" id="overlay"></div></div>
    </bard-mode-switcher>
    <gem-icon-button class="send-button"><button aria-label="Send message">send</button></gem-icon-button>
    <user-query-content></user-query-content>`;
  window.__clicked = [];
  window.chrome = { runtime: { sendMessage: async () => ({ prompt: "总结视频 https://example/v" }) } };

  const trigger = document.querySelector('button[data-test-id="bard-mode-menu-button"]');
  const overlay = document.getElementById("overlay");
  let selected = currentLabel;
  const setTrigger = () => (trigger.textContent = selected);
  setTrigger();
  window.__selected = () => selected;

  const render = () => {
    const gap = compact ? "" : "\n";
    overlay.innerHTML = `<div class="container"><div class="popover-menu"><gem-menu role="menu" data-test-id="gem-mode-menu">${items
      .map(([title, sub], i) => {
        const isLocked = locked.includes(title);
        const hash = isLocked ? "" : `hash${i}`;
        return `<gem-menu-item role="menuitemradio" data-mode-id="${hash}" data-test-id="bard-mode-option-${hash}"
          aria-checked="${title === selected}" aria-disabled="${isLocked}">
          <span class="label">${title}</span>${gap}<div class="sublabel">${sub}</div></gem-menu-item>`;
      })
      .join("")}
      <gem-menu-item role="menuitem" aria-haspopup="true" aria-disabled="false"><span class="label">思考等级</span></gem-menu-item>
      ${
        signIn
          ? `<gem-menu-item role="menuitem" data-test-id="mode-picker-sign-in-button" aria-disabled="false">
          <span class="label">${signIn[0]}</span>${gap}<div class="sublabel">${signIn[1]}</div></gem-menu-item>`
          : ""
      }
    </gem-menu></div></div>`;
  };
  // 和真实页面一样：带 popover 属性的元素不 showPopover() 就是 display:none。
  const popover = document.querySelector(".cdk-overlay-popover");
  const open = () => (render(), popover.showPopover());
  const close = () => (popover.hidePopover(), (overlay.innerHTML = ""));
  trigger.addEventListener("click", () => (overlay.firstChild ? close() : open()));
  overlay.addEventListener("click", (e) => {
    const item = e.target.closest("gem-menu-item");
    if (!item) return;
    const label = item.querySelector(".label").textContent;
    window.__clicked.push({
      label,
      locked: item.getAttribute("aria-disabled") === "true",
      promo: item.matches('[data-test-id="mode-picker-sign-in-button"]'),
    });
    if (item.getAttribute("aria-disabled") === "true") return; // 真实页面里点锁定项会弹登录框
    if (item.getAttribute("role") === "menuitemradio") selected = label;
    setTrigger();
    close();
  });
  document.querySelector(".send-button button").addEventListener("click", () => {
    document.querySelector("user-query-content").textContent = document.querySelector(".ql-editor").textContent;
  });
}

async function runScenario(browser, scenario) {
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  await page.goto("about:blank");
  const current = (M[scenario.current] || [scenario.current])[0];
  await page.evaluate(installFixture, {
    items: scenario.items,
    currentLabel: current,
    locked: scenario.locked || [],
    signIn: scenario.signIn || null,
    compact: Boolean(scenario.compact),
  });
  await page.addScriptTag({ content: CONTENT_JS });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !logs.some((t) => /已提交|未观察到提交气泡|放弃/.test(t))) {
    await page.waitForTimeout(100);
  }
  const result = await page.evaluate(() => ({
    selected: window.__selected(),
    clicked: window.__clicked,
    bubble: document.querySelector("user-query-content").textContent,
  }));
  await page.close();
  return { ...result, logs: logs.filter((t) => t.includes("YouTube → Gemini")) };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  for (const scenario of scenarios) {
    const r = await runScenario(browser, scenario);
    const problems = [];
    if (r.selected !== scenario.expect) problems.push(`最终选中 ${r.selected}，期望 ${scenario.expect}`);
    if (r.clicked.some((c) => c.locked)) problems.push("点击了锁定项");
    if (r.clicked.some((c) => c.promo)) problems.push("误点了“登录”推广项");
    if (r.clicked.some((c) => c.label === "思考等级")) problems.push("误点了“思考等级”子菜单入口");
    if (!r.bubble.includes("总结视频")) problems.push("prompt 没有提交");
    if (r.logs.some((t) => t.includes("沿用默认"))) problems.push("内容脚本报告“沿用默认”");
    console.log(`${problems.length ? "✗" : "✓"} ${scenario.name}`);
    if (problems.length) {
      failed++;
      for (const p of problems) console.log("    -", p);
      for (const l of r.logs) console.log("    log:", l);
    }
  }
  await browser.close();
  if (failed) {
    console.error(`\n${failed}/${scenarios.length} 个场景失败`);
    process.exit(1);
  }
  console.log(`\n全部 ${scenarios.length} 个场景通过`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
