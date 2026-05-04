# YouTube → Gemini Summarizer

一个轻量的 Chrome 扩展：在 YouTube 视频链接上右键，**后台**打开一个新的 Gemini 标签页，自动切到 **Fast 模型** 并发送 `总结视频 <URL>`。

## 功能

- 右键任意 YouTube 视频链接（`youtube.com/watch`、`youtu.be/...`、`youtube.com/shorts/...`、`music.youtube.com/watch` 等）→ 菜单项 **「用 Gemini 总结此 YouTube 视频」**。
- 在 YouTube 视频页面右键空白处 → 菜单项 **「用 Gemini 总结当前 YouTube 视频」**。
- 点击后会先**检测你是否登录了 Gemini**：
  - 已登录 → 后台静默打开新 Gemini 标签页 → 切到 Fast 模型 → 自动发送 `总结视频 <URL>`。
  - 未登录 → 在当前 YouTube 页面弹出提示，让你先去登录，**不会**自动开登录页。
- 全程使用你已登录的 Gemini 会话，无需 API Key。

## 安装（开发者模式）

1. 打开 Chrome → `chrome://extensions/`。
2. 右上角开启 **开发者模式 (Developer mode)**。
3. 点 **加载已解压的扩展程序 (Load unpacked)**，选择本目录。
4. 确认 Chrome 已经登录 Gemini（访问 https://gemini.google.com/app 验证）。

## 使用

- 在任何网页（YouTube、Twitter、Reddit、Discord Web 等）上找到 YouTube 视频链接，右键 → **「用 Gemini 总结此 YouTube 视频」**。
- 浏览器在后台静默打开新 Gemini 标签页，加载完成后会自动切 Fast 模型并发送提示词。
- 切换到该标签页即可看到生成结果。

## 文件结构

- `manifest.json` — Manifest V3 扩展声明。
- `background.js` — Service Worker：注册右键菜单、检测 Gemini 登录态（fetch + 跟随重定向）、未登录时通过 `chrome.scripting` 在当前 YouTube 页面 `alert()`、已登录则打开后台 Tab 并把 prompt 暂存到 `chrome.storage.session`。
- `content.js` — 注入到 `gemini.google.com`：取出当前 Tab 待发送的 prompt → 切到 Fast 模型 → 在 Quill 编辑器（`.ql-editor`）写入 → 点击 `button.send-button` → 等待 user-query 气泡确认提交成功。
- `test/run.js` — Playwright 端到端测试。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `contextMenus` | 注册右键菜单 |
| `storage` | 用 `chrome.storage.session` 把 prompt 从 background 传给 content script |
| `activeTab` | 未登录时，在当前 YouTube 页 `executeScript` 弹出提示 |
| `scripting` | 同上，配合 `activeTab` 注入提示 |
| `host_permissions: gemini.google.com/*` | 检测登录态 + 打开 Gemini Tab |

不需要 YouTube 域名的 `host_permissions` —— 我们用 `targetUrlPatterns` / `documentUrlPatterns` 让菜单只在 YouTube 链接上显示，未登录提示则借 `activeTab` 的临时授权。

## 故障排查

打开扩展打开的新 Tab，按 F12 → Console，日志都带 `[YouTube → Gemini]` 前缀：

- `已是 Fast 模型，跳过切换。` / `已切换到 Fast 模型。` —— 模型选择 OK
- `没找到模型选择器，沿用默认。` —— Gemini UI 改版，需要更新 `findModelTrigger`
- `未在 30s 内找到 Gemini 输入框。` —— `.ql-editor` 选择器需要更新
- `没找到发送按钮，放弃自动提交。` —— `findSendButton` 选择器需要更新
- `✓ 已提交。` —— 完整链路成功

## 端到端测试

`test/run.js` 是基于 Playwright 的 e2e 测试，覆盖完整链路：

- 在 SW 里把 `isLoggedIn` 打桩为 `false`，验证「未登录路径不开新 tab、返回 needsLogin」（**Phase A**）。
- 真实调用 `handleMenuClick`，等新 tab 出现，content.js 切 Fast 模型 + 写入 + 提交，断言对话历史里出现真实的 user-query 气泡（不是输入框里的文字），并且模型选择器最终文字是 `Fast` / `快速`（**Phase B**）。

第一次运行时会打开浏览器窗口让你登录一次 Gemini；登录态保存在 `/tmp/yt-gemini-test-profile`，后续运行直接免登录。

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
[Phase A] ✓ 未登录路径不开新 tab，仅返回 needsLogin。
[Phase B] handleMenuClick 返回: {"tabId":..., "prompt":"总结视频 https://..."}
[gemini-tab] log [YouTube → Gemini] 已是 Fast 模型，跳过切换。
[gemini-tab] log [YouTube → Gemini] ✓ 已提交。
当前模型选择器文本: 快速
✅ 端到端测试通过：prompt 已成功在 Gemini 对话中出现，模型为 Fast。
```

测试结束会保存截图到 `test/result.png`，内含 Gemini 对话历史里真实的用户气泡 —— 是「真的提交成功」的最强证据。

## 开发说明

修改代码后，到 `chrome://extensions/` 点该扩展卡片右下角的 **重新加载** 图标即可生效。

注意：Playwright persistent context 会缓存 service worker，修改 `background.js` 后如果 e2e 测试看起来跑的是旧代码，删掉 `/tmp/yt-gemini-test-profile` 重跑（需要重新登录一次）。
