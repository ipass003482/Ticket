const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const axios = require("axios");
const cheerio = require("cheerio");
const nodemailer = require("nodemailer");
const cron = require("node-cron");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const CHECK_INTERVAL = process.env.CHECK_INTERVAL || "*/1 * * * *";

const EMAIL_TO = process.env.EMAIL_TO || "";
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_TO;
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 18000);
const FETCH_RETRY_ATTEMPTS = Math.max(1, Number(process.env.FETCH_RETRY_ATTEMPTS || 4));
const FETCH_RETRY_BASE_MS = Number(process.env.FETCH_RETRY_BASE_MS || 800);
const FETCH_RETRY_MAX_MS = Number(process.env.FETCH_RETRY_MAX_MS || 12000);
const ENABLE_BROWSER_FALLBACK = String(process.env.FETCH_BROWSER_FALLBACK || "false").toLowerCase() === "true";
const BROWSER_TIMEOUT_MS = Number(process.env.BROWSER_TIMEOUT_MS || 45000);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_IDS = String(process.env.TELEGRAM_CHAT_IDS || "");
const LINE_NOTIFY_TOKEN = process.env.LINE_NOTIFY_TOKEN || "";

const FILE_EVENTS = path.join(__dirname, "events.json");
const FILE_SETTINGS = path.join(__dirname, "settings.json");
const FILE_STATE = path.join(__dirname, "state.json");

const FALLBACK_EVENTS = [
  {
    id: "klor6r",
    name: "KKTIX 活動 1 (klor6r)",
    url: "https://kktix.com/events/klor6r/registrations/new",
  },
  {
    id: "agt9r3tn",
    name: "KKTIX 活動 2 (agt9r3tn)",
    url: "https://kktix.com/events/agt9r3tn/registrations/new",
  },
];

const state = new Map();
const notified = new Set();
let monitoredEvents = [];
let settings = buildDefaultSettings();

function parseCsvList(raw = "") {
  return String(raw)
    .split(/[,;\n]/)
    .map((v) => String(v || "").trim())
    .filter((v) => v.length > 0);
}

function parseChatIds(raw = "") {
  return parseCsvList(raw)
    .map((v) => String(v))
    .filter((v) => /^-?\d+$/.test(v));
}

function normalizeEmails(input) {
  return [...new Set(parseCsvList(Array.isArray(input) ? input.join(",") : input))];
}

function buildDefaultSettings() {
  return {
    emails: normalizeEmails(EMAIL_TO),
    telegram: {
      enabled: false,
      chatIds: parseChatIds(TELEGRAM_CHAT_IDS),
    },
    line: {
      enabled: false,
    },
  };
}

function getPublicSettings() {
  return {
    emails: settings.emails,
    telegramEnabled: settings.telegram.enabled && Boolean(TELEGRAM_BOT_TOKEN),
    telegramChatIds: settings.telegram.chatIds,
    lineEnabled: settings.line.enabled && Boolean(LINE_NOTIFY_TOKEN),
  };
}

function parseEvent(rawEvent, index = 0) {
  const url = String(rawEvent?.url || "").trim();
  const name = String(rawEvent?.name || `KKTIX 活動 ${index + 1}`).trim();

  const matches = /\/events\/([^/?#]+)/i.exec(url);
  const id = String(rawEvent?.id || "").trim() || (matches ? matches[1] : `event-${Date.now()}-${index}`);

  if (!url.startsWith("https://kktix.com/events/") && !url.startsWith("http://kktix.com/events/")) {
    return null;
  }

  return {
    id,
    name: name || `KKTIX 活動 ${index + 1}`,
    url,
  };
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadEvents() {
  if (!(await fileExists(FILE_EVENTS))) {
    monitoredEvents = FALLBACK_EVENTS.map((e, i) => parseEvent(e, i));
    await persistEvents();
    return;
  }

  try {
    const raw = await fsp.readFile(FILE_EVENTS, "utf8");
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed) || parsed.length === 0) {
      monitoredEvents = FALLBACK_EVENTS.map((e, i) => parseEvent(e, i));
      return;
    }

    monitoredEvents = parsed
      .map((e, i) => parseEvent(e, i))
      .filter(Boolean);

    if (monitoredEvents.length === 0) {
      monitoredEvents = FALLBACK_EVENTS.map((e, i) => parseEvent(e, i));
    }

    const used = new Set();
    monitoredEvents = monitoredEvents.map((evt) => {
      let uniqueId = evt.id;
      while (used.has(uniqueId)) {
        uniqueId = `${evt.id}-${Math.random().toString(36).slice(2, 8)}`;
      }
      used.add(uniqueId);
      return { ...evt, id: uniqueId };
    });
  } catch (error) {
    console.error("events.json parse error, fallback to defaults", error.message || error);
    monitoredEvents = FALLBACK_EVENTS.map((e, i) => parseEvent(e, i));
  }
}

function normalizeSettingsPayload(payload = {}) {
  const next = {
    emails: normalizeEmails(payload.emails),
    telegram: {
      enabled: payload.telegram?.enabled === true,
      chatIds: parseChatIds(
        payload.telegram?.chatIds != null
          ? payload.telegram.chatIds
          : payload.telegramChatIds != null
            ? payload.telegramChatIds
            : TELEGRAM_CHAT_IDS
      ),
    },
    line: {
      enabled: payload.line?.enabled === true,
    },
  };

  if (!Object.prototype.hasOwnProperty.call(payload, "emails")) {
    next.emails = normalizeEmails(EMAIL_TO);
  }

  if (!Object.prototype.hasOwnProperty.call(payload, "telegram") && !Object.prototype.hasOwnProperty.call(payload, "telegramEnabled")) {
    next.telegram = {
      enabled: false,
      chatIds: parseChatIds(TELEGRAM_CHAT_IDS),
    };
  }

  if (!Object.prototype.hasOwnProperty.call(payload, "line") && !Object.prototype.hasOwnProperty.call(payload, "lineEnabled")) {
    next.line = {
      enabled: false,
    };
  }

  return next;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive);
}

function pickUserAgent() {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; rv:134.0) Gecko/20100101 Firefox/134.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  ];

  return userAgents[randomInt(userAgents.length)];
}

function buildBrowserHeaders(url) {
  const userAgent = pickUserAgent();

  return {
    "User-Agent": userAgent,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
    "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "sec-ch-ua": '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "navigate",
    "sec-fetch-user": "?1",
    "sec-fetch-dest": "document",
    "Upgrade-Insecure-Requests": "1",
    Referer: `${new URL(url).origin}/`,
  };
}

function isCloudflareChallengePage(html, statusCode = 0) {
  const text = String(html || "").toLowerCase();
  const flags = [
    "just a moment",
    "attention required",
    "cloudflare",
    "cf-ray",
    "cf-browser-verification",
    "verify you are human",
  ];

  return statusCode === 403 || flags.some((item) => text.includes(item));
}

function shouldRetryForError(error, statusCode, html) {
  if (statusCode === 403 || statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return true;
  }

  if (isCloudflareChallengePage(html, statusCode)) {
    return true;
  }

  const code = String(error?.code || "").toLowerCase();
  if (["econnreset", "econnaborted", "etimedout", "enotfound", "enotconn", "econnrefused", "timeout"].includes(code)) {
    return true;
  }

  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("timeout") || msg.includes("socket hang up") || msg.includes("network") || msg.includes("socket") || msg.includes("ecancelled");
}

function getRetryDelay(attempt) {
  const raw = Math.min(FETCH_RETRY_BASE_MS * Math.pow(1.9, attempt - 1), FETCH_RETRY_MAX_MS);
  const jitter = raw * 0.25 * Math.random();
  return Math.floor(raw + jitter);
}

async function fetchEventPageWithAxios(url) {
  const headers = buildBrowserHeaders(url);

  return axios.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 6,
    headers,
    validateStatus: (status) => status < 600,
  });
}

async function fetchEventPageWithBrowser(url) {
  let browser;
  let puppeteer;

  try {
    puppeteer = require("puppeteer");
  } catch (error) {
    throw new Error("未安裝 puppeteer，無法啟用 browser fallback");
  }

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    const userAgent = pickUserAgent();

    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      Referer: `${new URL(url).origin}/`,
    });

    const response = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: BROWSER_TIMEOUT_MS,
    });

    await page.waitForTimeout(1200);
    const html = await page.content();
    const status = response?.status?.() ?? 200;

    if (isCloudflareChallengePage(html, status)) {
      throw new Error(`browser 取得頁面仍被 cloudflare 攔截，status=${status}`);
    }

    return { data: html, status };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
async function fetchEventPage(url) {
  let lastErr = null;

  for (let attempt = 1; attempt <= FETCH_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchEventPageWithAxios(url);
      const status = response.status || 0;
      const html = String(response.data || "");

      if (isCloudflareChallengePage(html, status) || !response.data || status >= 400) {
        if (status === 403 && ENABLE_BROWSER_FALLBACK) {
          try {
            const browserResponse = await fetchEventPageWithBrowser(url);
            return browserResponse.data;
          } catch (browserError) {
            browserError.message = `browser fallback 失敗：${browserError.message}`;
            browserError.cause = { status, data: html };
            throw browserError;
          }
        }

        const error = new Error(`HTTP ${status}`);
        error.response = { status, data: html };
        throw error;
      }

      return html;
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const html = String(error?.response?.data || "");
      lastErr = error;

      if (error.message?.includes("browser fallback 失敗")) {
        throw error;
      }

      if (!shouldRetryForError(error, status, html) || attempt >= FETCH_RETRY_ATTEMPTS) {
        break;
      }

      const delay = getRetryDelay(attempt);
      await sleep(delay);
    }
  }

  if (ENABLE_BROWSER_FALLBACK) {
    try {
      const response = await fetchEventPageWithBrowser(url);
      return response.data;
    } catch (browserError) {
      browserError.message = `browser fallback 失敗：${browserError.message}`;
      browserError.cause = lastErr || browserError;
      throw browserError;
    }
  }

  throw lastErr || new Error("無法取得頁面，請確認連線與網站狀態");
}
async function loadSettings() {
  if (!(await fileExists(FILE_SETTINGS))) {
    settings = buildDefaultSettings();
    await persistSettings();
    return;
  }

  try {
    const raw = await fsp.readFile(FILE_SETTINGS, "utf8");
    const parsed = JSON.parse(raw || "{}");
    const normalized = normalizeSettingsPayload(parsed);

    settings = {
      emails: Array.isArray(normalized.emails) && normalized.emails.length > 0 ? normalized.emails : normalizeEmails(EMAIL_TO),
      telegram: {
        enabled: Boolean(normalized.telegram?.enabled) && Boolean(TELEGRAM_BOT_TOKEN),
        chatIds: normalizeEmails(normalized.telegram?.chatIds).map((v) => String(v)).filter((v) => /^-?\d+$/.test(v)),
      },
      line: {
        enabled: Boolean(normalized.line?.enabled) && Boolean(LINE_NOTIFY_TOKEN),
      },
    };
  } catch (error) {
    console.error("settings.json parse error, fallback to env defaults", error.message || error);
    settings = buildDefaultSettings();
  }
}

function syncStateWithEvents() {
  const knownIds = new Set(monitoredEvents.map((event) => event.id));

  for (const id of Array.from(state.keys())) {
    if (!knownIds.has(id)) {
      state.delete(id);
      notified.delete(id);
    }
  }

  for (const event of monitoredEvents) {
    if (!state.has(event.id)) {
      state.set(event.id, {
        id: event.id,
        name: event.name,
        url: event.url,
        available: false,
        rawHint: "尚未檢查",
        lastCheckedAt: null,
        error: null,
      });
    }

    const item = state.get(event.id);
    item.name = event.name;
    item.url = event.url;
  }
}

async function loadState() {
  if (!(await fileExists(FILE_STATE))) {
    syncStateWithEvents();
    await persistState();
    return;
  }

  try {
    const raw = await fsp.readFile(FILE_STATE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    const savedItems = parsed?.items || {};

    syncStateWithEvents();

    for (const event of monitoredEvents) {
      const saved = savedItems[event.id];
      if (!saved) {
        continue;
      }

      const item = state.get(event.id);
      item.available = Boolean(saved.available);
      item.rawHint = String(saved.rawHint || "尚未檢查");
      item.lastCheckedAt = saved.lastCheckedAt ? new Date(saved.lastCheckedAt) : null;
      item.error = saved.error || null;

      if (saved.notified) {
        notified.add(event.id);
      }
    }
  } catch (error) {
    console.error("state.json parse error, reset state", error.message || error);
    syncStateWithEvents();
  }
}

async function persistEvents() {
  await fsp.writeFile(FILE_EVENTS, JSON.stringify(monitoredEvents, null, 2), "utf8");
}

async function persistSettings() {
  const snapshot = {
    emails: settings.emails,
    telegram: settings.telegram,
    line: settings.line,
  };

  await fsp.writeFile(FILE_SETTINGS, JSON.stringify(snapshot, null, 2), "utf8");
}

async function persistState() {
  const snapshot = {
    generatedAt: new Date().toISOString(),
    items: {},
  };

  for (const [id, item] of state.entries()) {
    snapshot.items[id] = {
      available: item.available,
      rawHint: item.rawHint,
      lastCheckedAt: item.lastCheckedAt ? item.lastCheckedAt.toISOString() : null,
      error: item.error,
      notified: notified.has(id),
    };
  }

  await fsp.writeFile(FILE_STATE, JSON.stringify(snapshot, null, 2), "utf8");
}

function getTransport() {
  if (!SMTP_USER || !SMTP_PASS || settings.emails.length === 0) {
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

function parseAvailable(html) {
  const $ = cheerio.load(html);
  const bodyText = $.text().toLowerCase();

  const soldOutWords = [
    "售完",
    "sold out",
    "soldout",
    "已售罄",
    "已完售",
    "已截止",
    "已結束",
    "已停售",
    "目前暫不開放",
  ];

  if (soldOutWords.some((w) => bodyText.includes(w))) {
    return {
      available: false,
      reason: "頁面文字判定為已售罄或已截止",
    };
  }

  const actionWords = [
    "立即報名",
    "我要報名",
    "立即購票",
    "馬上報名",
    "join now",
    "register",
    "buy tickets",
    "buy now",
    "add to cart",
  ];

  const hasActionText = actionWords.some((w) => bodyText.includes(w));
  const hasEnabledActionButton = $("button, a").toArray().some((el) => {
    const $el = $(el);
    const text = ($el.text() || "").toLowerCase().trim();
    const hasActionWord = actionWords.some((word) => text.includes(word));
    const disabled =
      $el.attr("disabled") === "disabled" ||
      String($el.attr("aria-disabled") || "").toLowerCase() === "true" ||
      $el.hasClass("is-disabled");
    return hasActionWord && !disabled;
  });

  if (hasActionText || hasEnabledActionButton) {
    return {
      available: true,
      reason: "頁面偵測到可互動報名/購票相關文字",
    };
  }

  return {
    available: false,
    reason: "未偵測到可報名/購票動作入口",
  };
}

function nowIso(d) {
  return d ? d.toISOString() : null;
}

async function sendEmailAlert(event, item) {
  const transporter = getTransport();
  if (!transporter) {
    return { ok: false, channel: "email", detail: "SMTP 未設定或未有收件人" };
  }

  const subject = `【有票通知】${event.name} 目前可購票`;
  const html = `
    <h2>🎟️ ${event.name}</h2>
    <p>偵測到頁面可能已放票，請盡快前往確認。</p>
    <p><a href="${event.url}" target="_blank">立即前往活動頁</a></p>
    <p>判斷依據：${item.rawHint}</p>
    <p>檢查時間：${nowIso(item.lastCheckedAt)}</p>
  `;

  await transporter.sendMail({
    from: EMAIL_FROM || settings.emails[0],
    to: settings.emails,
    subject,
    html,
  });

  return { ok: true, channel: "email", detail: `已寄給 ${settings.emails.length} 位收件人` };
}

async function sendTelegramAlert(event, item) {
  if (!settings.telegram.enabled || !TELEGRAM_BOT_TOKEN) {
    return { ok: false, channel: "telegram", detail: "Telegram 未啟用或缺少 bot token" };
  }

  const chatIds = settings.telegram.chatIds.length > 0
    ? settings.telegram.chatIds
    : parseChatIds(TELEGRAM_CHAT_IDS);

  if (chatIds.length === 0) {
    return { ok: false, channel: "telegram", detail: "未設定 Telegram chat_id" };
  }

  const msg = `[有票通知] ${event.name}\n${event.url}\n時間：${nowIso(item.lastCheckedAt)}\n${item.rawHint}`;
  const tasks = chatIds.map((chatId) =>
    axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: msg,
      disable_web_page_preview: true,
    }, { timeout: 15000 })
  );

  await Promise.all(tasks);
  return { ok: true, channel: "telegram", detail: `已寄給 ${chatIds.length} 個 chat_id` };
}

async function sendLineAlert(event, item) {
  if (!settings.line.enabled || !LINE_NOTIFY_TOKEN) {
    return { ok: false, channel: "line", detail: "LINE Notify 未啟用或缺少 token" };
  }

  const msg = `[有票通知] ${event.name}\n${event.url}\n時間：${nowIso(item.lastCheckedAt)}\n${item.rawHint}`;

  await axios.post(
    "https://notify-api.line.me/api/notify",
    new URLSearchParams({ message: msg }).toString(),
    {
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${LINE_NOTIFY_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  return { ok: true, channel: "line", detail: "已寄到 LINE Notify" };
}

async function sendTicketAlert(event, item) {
  const tasks = [sendEmailAlert(event, item), sendTelegramAlert(event, item), sendLineAlert(event, item)];
  const settled = await Promise.allSettled(tasks);

  const channelResults = settled.map((result, idx) => {
    const labels = ["email", "telegram", "line"];
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      ok: false,
      channel: labels[idx],
      detail: String(result.reason?.message || result.reason || "發送失敗"),
    };
  });

  return {
    sent: channelResults.some((item) => item.ok),
    channels: channelResults,
  };
}

async function checkEvent(event) {
  const item = state.get(event.id);
  const prevAvailable = item.available;

  try {
    const html = await fetchEventPage(event.url);
    const parsed = parseAvailable(html);
    item.available = parsed.available;
    item.rawHint = parsed.reason;
    item.lastCheckedAt = new Date();
    item.error = null;

    if (item.available && !prevAvailable && !notified.has(event.id)) {
      const result = await sendTicketAlert(event, item);
      if (result.sent) {
        notified.add(event.id);
        console.log(`[ALERT] ${event.name} 已觸發通知`, result.channels);
      }
    }

    if (!item.available) {
      notified.delete(event.id);
    }

    return { ...item, changed: item.available !== prevAvailable, alerts: item.available && !prevAvailable ? [] : [] };
  } catch (error) {
    item.error = String(error.message || error);
    item.lastCheckedAt = new Date();
    return { ...item, changed: false, alerts: [] };
  }
}

async function checkAll() {
  const results = [];
  for (const event of monitoredEvents) {
    results.push(await checkEvent(event));
  }
  await persistState();
  return results;
}

app.get("/api/events", (_req, res) => {
  res.json(monitoredEvents);
});

app.post("/api/events", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const url = String(req.body?.url || "").trim();

    const event = parseEvent({ name, url }, monitoredEvents.length + 1);
    if (!event) {
      res.status(400).json({ ok: false, message: "網址格式必須是 kktix.com/events/..." });
      return;
    }

    if (monitoredEvents.some((e) => e.id === event.id)) {
      event.id = `${event.id}-${Math.random().toString(36).slice(2, 8)}`;
    }

    monitoredEvents.push(event);
    syncStateWithEvents();
    await persistEvents();
    await persistState();

    res.status(201).json({ ok: true, event });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || "新增失敗" });
  }
});

app.delete("/api/events/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  const before = monitoredEvents.length;
  monitoredEvents = monitoredEvents.filter((event) => event.id !== id);

  if (monitoredEvents.length === before) {
    res.status(404).json({ ok: false, message: "找不到該活動" });
    return;
  }

  syncStateWithEvents();
  await persistEvents();
  await persistState();

  res.json({ ok: true });
});

app.get("/api/settings", (_req, res) => {
  res.json(getPublicSettings());
});

app.post("/api/settings", async (req, res) => {
  const payload = req.body || {};
  const next = normalizeSettingsPayload(payload);

  settings = {
    emails: (payload.emails != null || payload.emailList != null) ? normalizeEmails(payload.emails || payload.emailList || []) : next.emails,
    telegram: {
      enabled: (payload.telegramEnabled != null ? Boolean(payload.telegramEnabled) : payload.telegram?.enabled === true) && Boolean(TELEGRAM_BOT_TOKEN),
      chatIds: parseChatIds((payload.telegramChatIds != null ? payload.telegramChatIds : payload.telegram?.chatIds) || TELEGRAM_CHAT_IDS),
    },
    line: {
      enabled: (payload.lineEnabled != null ? Boolean(payload.lineEnabled) : payload.line?.enabled === true) && Boolean(LINE_NOTIFY_TOKEN),
    },
  };

  await persistSettings();
  res.json({ ok: true, settings: getPublicSettings() });
});

app.get("/api/status", (_req, res) => {
  res.json({
    generatedAt: new Date().toISOString(),
    events: Array.from(state.values()),
    autoCron: CHECK_INTERVAL,
    settings: getPublicSettings(),
    mailReady: Boolean(getTransport()),
    telegramReady: settings.telegram.enabled && Boolean(TELEGRAM_BOT_TOKEN),
    lineReady: settings.line.enabled && Boolean(LINE_NOTIFY_TOKEN),
  });
});

app.post("/api/check-now", async (_req, res) => {
  const events = await checkAll();
  res.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    events,
  });
});

cron.schedule(CHECK_INTERVAL, async () => {
  try {
    const events = await checkAll();
    const anyAvailable = events.some((item) => item.available);
    if (anyAvailable) {
      console.log(`[MONITOR] ${nowIso(new Date())} 有可購票活動：`,
        events.filter((e) => e.available).map((e) => e.name).join("，")
      );
    }
  } catch (error) {
    console.error("cron check error", error);
  }
});

(async () => {
  await loadEvents();
  await loadSettings();
  syncStateWithEvents();
  await loadState();

  app.listen(PORT, async () => {
    console.log(`KKTIX 監控服務已啟動：http://localhost:${PORT}`);
    console.log(`預設檢查排程：${CHECK_INTERVAL}`);
    console.log(`目前監控活動：${monitoredEvents.length} 場`);
    await checkAll();
  });
})();


