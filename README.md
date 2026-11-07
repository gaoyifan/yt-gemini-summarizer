# YouTube → Gemini Summarizer

一个轻量的 Chrome 扩展：在 YouTube 视频链接上右键，**后台**打开一个新的 Gemini 标签页，自动选好模型并发送 `总结视频 <URL>`。模型偏好：**优先 Flash**；Flash 不可用（比如未登录时被锁定）才退回 **Flash-Lite**。

## 功能

- 右键任意 YouTube 视频链接（`youtube.com/watch`、`youtu.be/...`、`youtube.com/shorts/...`、`music.youtube.com/watch` 等）→ 菜单项 **「用 Gemini 总结此 YouTube 视频」**。
- 在 YouTube 视频页面右键空白处 → 菜单项 **「用 Gemini 总结当前 YouTube 视频」**。
- 点击后会直接在后台静默打开新 Gemini 标签页 → 选择模型（Flash，不可用则 Flash-Lite）→ 自动发送 `总结视频 <URL>`。
- 无需 API Key；扩展不主动检测登录状态，交给 Gemini 页面自身处理。

## 安装（开发者模式）

1. 打开 Chrome → `chrome://extensions/`。
2. 右上角开启 **开发者模式 (Developer mode)**。
3. 点 **加载已解压的扩展程序 (Load unpacked)**，选择本目录。
4. 访问 https://gemini.google.com/app 确认 Gemini 在当前浏览器中可用。

## 使用

- 在任何网页（YouTube、Twitter、Reddit、Discord Web 等）上找到 YouTube 视频链接，右键 → **「用 Gemini 总结此 YouTube 视频」**。
- 浏览器在后台静默打开新 Gemini 标签页，加载完成后会自动选好模型并发送提示词。
- 切换到该标签页即可看到生成结果。

## 文件结构

- `manifest.json` — Manifest V3 扩展声明。
- `background.js` — Service Worker：注册右键菜单、打开后台 Gemini Tab，并把 prompt 暂存到 `chrome.storage.session`。
- `content.js` — 注入到 `gemini.google.com`：取出当前 Tab 待发送的 prompt → 选择模型 → 在 Quill 编辑器（`.ql-editor`）写入 → 点击发送按钮 → 等待 user-query 气泡确认提交成功。
- `test/run.js` — Playwright 端到端测试（真实 Gemini 页面）。
- `test/model-selection.js` — 模型选择的确定性测试（DOM 夹具，不联网）。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `contextMenus` | 注册右键菜单 |
| `storage` | 用 `chrome.storage.session` 把 prompt 从 background 传给 content script |
| `host_permissions: gemini.google.com/*` | 允许 content script 在 Gemini 页运行 |

不需要 YouTube 域名的 `host_permissions` —— 我们用 `targetUrlPatterns` / `documentUrlPatterns` 让菜单只在 YouTube 链接上显示。

## 故障排查

打开扩展打开的新 Tab，按 F12 → Console，日志都带 `[YouTube → Gemini]` 前缀：

- `已是目标模型: …` / `已切换到: …` —— 模型选择 OK
- `没找到模型选择器，沿用默认。` —— Gemini UI 改版，需要更新 `findModelTrigger`
- `打开了模型菜单但找不到可用的 Flash / Flash-Lite 选项，沿用默认。` —— 菜单结构或文案改版，需要更新 `findModelItems` / `MODEL_PREFERENCE`

模型选择的几个坑（都踩过）：

- 菜单已不在 `.cdk-overlay-container` 里，菜单项的 role 是 `menuitemradio`（不是 `menuitem`），`data-test-id` 里是哈希而不是模型名；所以按 ARIA 角色在整个文档里找，再按文字匹配。
- 是否选中看菜单项的 `aria-checked`；被锁定的项带 `aria-disabled="true"`（未登录时的 Flash / Pro / Argon），不能点——点了会弹登录框。
- 未登录时菜单底部有个“Sign in …”推广项，它是普通 `menuitem`（模型项是 `menuitemradio`，带 `aria-checked`），文案有时还带 “Flash”（比如 “Sign in for all models / Try the latest Flash”）；点了会跳去登录，prompt 就发不出去。所以菜单里有 `menuitemradio` 时只在它们里面选。
- “Flash-Lite” 的名字里也含 “Flash”，匹配 Flash 时要用 `\bFlash\b(?!-Lite)` 排除它。
- 不要拿按钮文字判断“已经是目标模型”：旧代码用 `/Flash/` 去测按钮文字，把 `Flash-Lite` 也当成了 Flash，于是跳过切换。
- 模型选择器在页面加载后通常 3–6 秒出现（登录与否都一样），但 24 次实测里有 2 次要 10–12 秒，所以等待窗口给到 20 秒；它不依赖输入框里有没有内容。
- `未在 30s 内找到 Gemini 输入框。` —— `.ql-editor` 选择器需要更新
- `没找到发送按钮，放弃自动提交。` —— `findSendButton` 选择器需要更新
- `✓ 已提交。` —— 完整链路成功

## 端到端测试

`test/run.js` 是基于 Playwright 的 e2e 测试，覆盖完整链路：

- 真实调用 `handleMenuClick`，等新 tab 出现，content.js 写入 + 选模型 + 提交，断言：对话历史里出现真实的 user-query 气泡（不是输入框里的文字）；content.js 明确报告“已是目标模型/已切换到”（出现“沿用默认”即失败）；页面上模型选择器的 `aria-label` 是 Flash 系列（Pro / Argon 等不接受）。

注意：未登录的测试 profile 里 Flash 被锁定，Gemini 默认就是 Flash-Lite，所以这个 e2e 只能覆盖“Flash 不可用 → 退回 Flash-Lite”这条路径；而登录账号的新对话默认就是 Flash，“选中了 Flash”和“什么都没做”结果一样，也分不出来。

所以模型选择的各条分支另有一个确定性测试 `test/model-selection.js`（`npm run test:model`）：用最小 DOM 夹具（结构和属性照抄真实 Gemini：`bard-mode-switcher` 里的 `.cdk-overlay-popover`、`menuitemradio`、`aria-checked`、锁定项的 `aria-disabled`、带 `popover` 的弹层要 `showPopover()` 才可见）跑真实的 `content.js`，覆盖：当前是 Flash-Lite / Pro → 切到 Flash；已是 Flash → 不误选 Flash-Lite；Flash 被锁定 → 退回 Flash-Lite 且绝不点锁定项，也不点文案里带 Flash 的“Sign in”推广项；没有 Flash；旧版“快速 / Fast”菜单。夹具是按真实 DOM 手工搭的，Gemini 改版后要先对照真实页面更新夹具。

每次运行都会用一个全新的临时浏览器 profile（结束后删除），所以总是以未登录状态测试；扩展本身不做登录检测。

```bash
cd test
npm install            # 第一次运行
npx playwright install chromium

node run.js                                                     # 默认测视频
YT2G_LINK="https://youtu.be/9bZkp7q19f0" node run.js             # 顺便验证 youtu.be 短链
YT2G_KEEP_OPEN=1 node run.js                                    # 不要关浏览器，便于排查
```

成功输出（约 10 秒）：

```
handleMenuClick 返回: {"tabId":..., "prompt":"总结视频 https://..."}
[gemini-tab] log [YouTube → Gemini] 已是目标模型: 3.5 Flash-Lite Fastest answers
[gemini-tab] log [YouTube → Gemini] ✓ 已提交。
当前模型选择器: Open mode picker, currently Flash-Lite | Flash-Lite
端到端测试通过：prompt 已提交，模型为 Flash 系列。
```

测试结束会保存截图到 `test/result.png`，内含 Gemini 对话历史里真实的用户气泡 —— 是「真的提交成功」的最强证据。

## 开发说明

修改代码后，到 `chrome://extensions/` 点该扩展卡片右下角的 **重新加载** 图标即可生效。
