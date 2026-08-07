# JSON Formatter & Validator

一個重視隱私與專業工作流的線上 JSON 編輯器。所有格式化、驗證、搜尋與本機儲存都在瀏覽器內完成。

**線上工具：** https://json-formatter-validator.owowen.chatgpt.site

## 功能

- CodeMirror 6 編輯器：語法上色、括號配對、程式碼摺疊、搜尋取代
- Undo／Redo 與精確錯誤標記
- 格式化、壓縮、排序鍵值、複製與下載
- 程式碼與可展開樹狀檢視
- JSONPath Breadcrumb、節點路徑／值／JSON 複製
- 拖放或選取 JSON 檔案
- 可拖曳調整雙欄寬度
- 手機版輸入／結果分頁
- 深色模式
- 瀏覽器本機自動保存與還原

## 技術

- Vinext / React
- TypeScript
- CodeMirror 6
- Cloudflare Workers 相容輸出
- OpenAI Sites 部署

## 本機開發

需求：Node.js 22.13 或更新版本。

```bash
npm ci
npm run dev
```

正式建置與驗證：

```bash
npm run build
```

## 隱私

JSON 內容不會上傳到伺服器。自動保存功能使用瀏覽器的 localStorage。
