# KKTIX 票務釋票監控（本機版）

這是一個本機可執行的 Node.js 小工具，會定時監控 KKTIX 活動頁是否有可購票狀態，並透過：

- Email（Nodemailer）
- Telegram（Bot）
- LINE Notify

寄送通知。

## 專案特色

- 支援兩個預設活動：
  - https://kktix.com/events/klor6r/registrations/new
  - https://kktix.com/events/agt9r3tn/registrations/new
- 監控清單可在網頁中即時新增/刪除（會儲存到 `events.json`）
- 通知收件人可在網頁中編輯並保存（會儲存到 `settings.json`）
- 狀態會儲存在 `state.json`（已加入 `.gitignore`）

## 本機啟動方式

1. 安裝套件

   `npm install`

2. 建立環境變數

   - 複製 `.env.example` 成 `.env`
   - 填入 `SMTP_*`、`EMAIL_TO`，以及可選的 Telegram/LINE 欄位
   - 如遇 Cloudflare 擋請求，請在 `.env` 補上：
     - `FETCH_RETRY_ATTEMPTS`、`FETCH_RETRY_BASE_MS`、`FETCH_RETRY_MAX_MS`（控制重試）
     - `FETCH_TIMEOUT_MS`（HTTP 請求逾時）
     - `FETCH_BROWSER_FALLBACK=true`（重試仍失敗時改用 Puppeteer）
   - 目前預設每分鐘自動檢查，請確認有：
     - `CHECK_INTERVAL=*/1 * * * *`

3. 啟動服務

   `npm start`

4. 開啟瀏覽器

   `http://localhost:3000`

## 使用教學（你可以直接照這流程做）

1. 複製 `.env.example` 成 `.env`
2. 確認 `.env` 有填：
   - `CHECK_INTERVAL=*/1 * * * *`（預設每分鐘）
   - `FETCH_BROWSER_FALLBACK=true`（建議開啟，避免 KKTIX 403）
3. 安裝套件：
   - `npm install`
   - 若要用瀏覽器 fallback，補裝：`npm install puppeteer`
4. 啟動服務：
   - `npm start`
5. 開啟主頁：
   - `http://localhost:3000`
6. 手動測試：
   - 直接按「立即檢查」按鈕，或呼叫：
   - `POST http://localhost:3000/api/check-now`
7. 判斷結果重點：
   - `available: true`：有票（或頁面判斷為可購票）
   - `error` 有值：抓不到頁面，多半是被 403/防護擋住

> 注意：太頻繁（小於 20~30 秒）可能會更容易被 KKTIX 限流，建議從每分鐘起步再調整。

## 擴充其他網站監控（自訂站點）

目前預設有支援 KKTIX。要監控其他售票網站也可以，做法是：

1. 在 `events.json` 加入 `site` 欄位，指定站點類型
   - KKTIX 用 `kktix`
   - 其他你新增的網站可使用自己的 key，例如 `eventsite-a`
2. 在 `server.js` 的解析邏輯新增對應 parser
3. 把 parser 對應到 `site` key，就能共用原本排程、寄信、LINE、Telegram 流程

### 1) 先在 `events.json` 加新站點欄位

```json
[
  {
    "id": "klor6r",
    "name": "KKTIX 活動 1",
    "url": "https://kktix.com/events/klor6r/registrations/new",
    "site": "kktix"
  },
  {
    "id": "abc123",
    "name": "其他網站活動",
    "url": "https://example.com/event/abc123",
    "site": "other-site"
  }
]
```

> `site` 留空時，程式可預設用 `kktix` parser。

### 2) 在 `server.js` 新增一個判斷函式

在 `server.js` 新增新網站偵測邏輯，回傳 `{ available, reason }`：

```js
function parseOtherSite(html) {
  const $ = cheerio.load(html);
  const text = $.text().toLowerCase();

  const soldOutWords = ["sold out", "soldout", "已售罄", "售完", "不可購票"];
  const actionWords = ["立即購票", "buy now", "加入購物車", "register"];

  if (soldOutWords.some((w) => text.includes(w))) {
    return { available: false, reason: "other-site: 判斷為售完/關閉" };
  }

  const hasAction = $("button, a").toArray().some((el) => {
    const t = ($(el).text() || "").toLowerCase();
    const disabled =
      $(el).attr("disabled") === "disabled" ||
      String($(el).attr("aria-disabled") || "").toLowerCase() === "true";
    return actionWords.some((w) => t.includes(w)) && !disabled;
  });

  return { available: hasAction, reason: hasAction ? "other-site: 偵測到可購票動作" : "other-site: 未偵測到可購票動作" };
}
```

### 3) 註冊 parser 到 `site` 對應表

```js
const parsers = {
  kktix: parseKktix,
  "other-site": parseOtherSite,
};

function detectBySite(site, html) {
  const parse = parsers[site] || parsers.kktix;
  return parse(html);
}
```

### 4) 在 `checkEvent` 使用站點 parser

```js
const parserSite = event.site || "kktix";
const { available, reason } = detectBySite(parserSite, response.data);
```

這樣每個網站都能套各自規則，不會影響你現有 KKTIX 設定與 UI。

## 上傳到 GitHub（使用者本機運行版本）

你不用把整個系統佈署到雲端。這裡是給你自己的 GitHub 倉庫作為分享與安裝入口：

1. 先在 GitHub 建立一個新空 repo（例如 `kktix-ticket-monitor`）
2. 在本機目錄下執行（Windows PowerShell）：

   ```powershell
   git init
   git add .
   git commit -m "feat: initial ticket monitor with email/telegram/line and local settings"
   git branch -M main
   git remote add origin https://github.com/<你的帳號>/<你的倉庫名>.git
   git push -u origin main
   ```

> 你的 `.env`、`state.json` 不會上傳到 GitHub。

## 注意

- `state.json` 會記錄已發送狀態，重開機時可避免重複通知。
- 判斷規則以頁面關鍵文字 + 按鈕可點擊狀態為主，若 KKTIX 畫面結構有變化可再調整偵測規則。
