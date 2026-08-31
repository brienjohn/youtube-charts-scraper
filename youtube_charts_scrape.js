// YouTube Music Charts 爬蟲：TrendingVideos / TopVideos(日+週) / TopSongs(週) / TopArtists(週)
// 資料來源：charts.youtube.com（不需登入）
// 技術備註：這個網站的榜單內容放在 Shadow DOM 裡，一般 DOM 選擇器讀不到，
// 改用瀏覽器的無障礙輔助樹（accessibility tree）讀取畫面上實際顯示的文字，
// 再照內容樣式（日期格式、純數字）去分類是標題、藝人名、日期還是觀看數。
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import * as OpenCC from "opencc-js";

// 簡體轉台灣繁體：YouTube 頁面上偶爾會出現簡體字內容（例如陸區上傳的歌曲），
// 但音樂產業日報的鐵律是「絕不出現簡體字」，所以歌名/藝人名一律先轉一輪繁體再寫入
const s2tConverter = OpenCC.Converter({ from: "cn", to: "tw" });

const MARKETS = {
  global: "Global",
  tw: "Taiwan",
  jp: "Japan",
  kr: "South Korea",
  vn: "Vietnam",
  th: "Thailand",
  id: "Indonesia",
  in: "India",
  sg: "Singapore",
  my: "Malaysia",
};

const CURRENT_CHARTS = [
  { key: "trending_videos", pathName: "TrendingVideos", timeframe: null },
  { key: "top_videos_daily", pathName: "TopVideos", timeframe: "daily" },
  { key: "top_videos_weekly", pathName: "TopVideos", timeframe: "weekly" },
  { key: "top_songs_weekly", pathName: "TopSongs", timeframe: "weekly" },
  { key: "top_artists_weekly", pathName: "TopArtists", timeframe: "weekly" },
  { key: "top_shorts_songs_daily", pathName: "TopShortsSongs", timeframe: "daily" },
  { key: "top_shorts_songs_weekly", pathName: "TopShortsSongs", timeframe: "weekly" },
];

// 可以回溯歷史的榜：週榜網址帶 YYYYMMDD 往回跳 7 天，日榜往回跳 1 天
// （TrendingVideos 是即時性質，無法回溯，不列在這裡）
const BACKFILLABLE_CHARTS = [
  { key: "top_songs_weekly", pathName: "TopSongs", timeframe: "weekly" },
  { key: "top_artists_weekly", pathName: "TopArtists", timeframe: "weekly" },
  { key: "top_videos_daily", pathName: "TopVideos", timeframe: "daily" },
  { key: "top_videos_weekly", pathName: "TopVideos", timeframe: "weekly" },
  { key: "top_shorts_songs_daily", pathName: "TopShortsSongs", timeframe: "daily" },
  { key: "top_shorts_songs_weekly", pathName: "TopShortsSongs", timeframe: "weekly" },
];

// 回溯要抓到多早：抓到這天（含）附近就停，不用每次手動調期數上限
const BACKFILL_TARGET_DATE = "20260101";

// 日期格式判斷：改成 en-US 語系後，頁面上的日期預期會變成「Dec 18, 2024」這種英文月份格式，
// 但保留中文格式（「12月 18, 2024」）的比對，以防某些欄位語系沒有完全跟著切換
const DATE_PATTERN_ZH = /\d{1,2}\s*月\s*\d{1,2},?\s*\d{4}/;
const DATE_PATTERN_EN = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s*\d{4}\b/i;
const DATE_PATTERN = new RegExp(`(?:${DATE_PATTERN_ZH.source})|(?:${DATE_PATTERN_EN.source})`);
const PURE_NUMBER_PATTERN = /^[\d,]{2,}$/;

function taipeiDateString(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

function buildUrl(pathName, cc, timeframe, dateSuffix) {
  let url = `https://charts.youtube.com/charts/${pathName}/${cc}`;
  if (timeframe) url += `/${timeframe}`;
  if (dateSuffix) url += `/${dateSuffix}`;
  return url;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((h) => escape(row[h])).join(","))].join("\n");
}

function writeCsvWithBom(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!rows.length) return;
  fs.writeFileSync(filePath, "\uFEFF" + toCsv(rows), "utf8");
}

async function debugCapture(page, label) {
  fs.mkdirSync("debug", { recursive: true });
  await page.screenshot({ path: `debug/${label}.png`, fullPage: true }).catch(() => null);
}

async function scrapeChart(page, url, ctx) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

  // 縮圖元素本身可以用 Playwright 的選取器直接找到（會自動穿透 Shadow DOM），
  // 這比呼叫已經不建議使用的 page.accessibility.snapshot() 更可靠
  const thumbLocator = page.locator('[aria-label*="thumbnail" i], img[alt*="thumbnail" i]');

  const found = await thumbLocator
    .first()
    .waitFor({ state: "attached", timeout: 20000 })
    .then(() => true)
    .catch(() => false);

  if (!found) {
    await debugCapture(page, `${ctx.cc}_${ctx.chartKey}${ctx.dateSuffix ? "_" + ctx.dateSuffix : ""}`);
    return [];
  }

  await page.waitForTimeout(1000);

  const thumbs = await thumbLocator.all();
  const rawRows = [];
  for (const thumb of thumbs) {
    try {
      const data = await thumb.evaluate((el) => {
        // 縮圖本身可能是 <img> 標籤，也可能是用 CSS 背景圖呈現的元素，兩種都要處理
        const getImgUrl = (node) => {
          if (node.tagName === "IMG" && node.src) return node.src;
          const bg = node.style?.backgroundImage || getComputedStyle(node).backgroundImage;
          const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
          return m ? m[1] : null;
        };
        const imageUrl = getImgUrl(el) || (el.querySelector && getImgUrl(el.querySelector("img")) ) || null;

        // 收集一個節點底下「每個最底層文字元素」各自的文字，
        // 保留標題／藝人名／日期／數字彼此原本的元素邊界，
        // 不要黏成一整串再事後用數字/日期去猜分界點
        function collectParts(node) {
          const parts = [];
          function walk(n) {
            const children = n.children ? Array.from(n.children) : [];
            if (!children.length) {
              const t = (n.textContent || "").replace(/\s+/g, " ").trim();
              if (t) parts.push(t);
              return;
            }
            for (const c of children) walk(c);
          }
          walk(node);
          return parts;
        }

        let node = el;
        for (let i = 0; i < 8 && node && node.parentElement; i++) {
          node = node.parentElement;
          const t = node.textContent.replace(/\s+/g, " ").trim();
          if (t.length > 15) {
            return { text: t, parts: collectParts(node), imageUrl };
          }
        }
        return {
          text: node ? node.textContent.replace(/\s+/g, " ").trim() : "",
          parts: node ? collectParts(node) : [],
          imageUrl,
        };
      });
      if (data.text) rawRows.push(data);
    } catch (e) {
      // 忽略單一列讀取失敗，不影響其他列
    }
  }

  if (!rawRows.length) {
    await debugCapture(page, `${ctx.cc}_${ctx.chartKey}${ctx.dateSuffix ? "_" + ctx.dateSuffix : ""}`);
    return [];
  }

  return rawRows.map(({ text, parts, imageUrl }, i) => {
    const parsed = classifyRowText(text, parts);
    return {
      captured_date: ctx.today,
      market: ctx.cc,
      market_name: ctx.marketName,
      chart: ctx.chartKey,
      period_suffix: ctx.dateSuffix || "",
      rank: i + 1,
      image_url: imageUrl || "",
      ...parsed,
    };
  });
}

function classifyRowText(rawText, parts = []) {
  const dateMatch = rawText.match(DATE_PATTERN);
  const releaseDate = dateMatch ? dateMatch[0] : "";
  // 算觀看數之前要先把日期字串本身拿掉，不然像「Jul 30, 2026」裡的「2026」
  // 會被誤判成觀看數（因為它也是連續 3 位以上的數字）
  const textForMetric = releaseDate ? rawText.replace(releaseDate, " ") : rawText;

  const isRankBadge = (s) => /^[-▲▼]?\s*\d{0,3}$/.test(s) || /^New$/i.test(s);
  const isDateStr = (s) => DATE_PATTERN.test(s);
  const isPureNumber = (s) => PURE_NUMBER_PATTERN.test(s.replace(/,/g, ""));
  // YouTube 對觀看數很少的影片會顯示「<10K」這種縮寫格式，不是單純數字，
  // 這種格式不該被當成標題或藝人名的一部分
  const isLowCountMarker = (s) => /^<\s*\d+[KMB]?$/i.test(s);
  // 整個元素本身就是純符號（例如畫面上獨立的圓點小圖示「●」）→ 整段視為裝飾，丟棄
  const isSymbolOnly = (s) => !/[\p{L}\p{N}]/u.test(s);
  // 符號跟文字黏在同一個元素、中間用空白隔開（例如「● 阿爾卡·雅格尼克」）→ 只裁掉符號那個「詞」。
  // 注意：不能用「開頭/結尾任何非文字字元」這種寫法，否則會連歌名本身的括號、引號等標點
  // 也一起裁掉（例如「甲乙丙丁 (你我怎么两清)」結尾緊貼的「)」就不該被裁掉）
  const stripSymbolTokens = (s) =>
    s
      .replace(/^[^\p{L}\p{N}\s]+(?=\s)/u, "")
      .replace(/(?<=\s)[^\p{L}\p{N}\s]+$/u, "")
      .trim();

  const numberMatches = textForMetric.match(/\d[\d,]{2,}/g) || [];
  const lowCountMatch = textForMetric.match(/<\s*\d+[KMB]?/i);
  const metricValue = numberMatches.length
    ? numberMatches[numberMatches.length - 1].replace(/,/g, "")
    : lowCountMatch
      ? lowCountMatch[0].replace(/\s+/g, "")
      : "";

  // 優先用「元素邊界」分出的 parts 判斷標題／藝人名，
  // 這比用數字/日期的位置去猜邊界準確，因為多數列根本沒有數字或日期可以當分界點
  const nameParts = parts
    .filter((p) => !isSymbolOnly(p) && !isLowCountMarker(p))
    .map(stripSymbolTokens)
    .filter((p) => p && !isRankBadge(p) && !isDateStr(p) && !isPureNumber(p));

  if (nameParts.length >= 2) {
    return {
      primary_name: s2tConverter(nameParts[0]),
      secondary_name: s2tConverter(nameParts.slice(1).join(" / ")),
      release_date: releaseDate,
      metric_value: metricValue,
      raw_text: rawText.slice(0, 300),
    };
  }

  // parts 資訊不足時的備援邏輯（跟舊版行為相同，理論上不該常常用到）
  let text = rawText.replace(/^\s*\d{1,3}\s*(New\s*)?/i, "").trim();
  let withoutDate = releaseDate ? text.replace(releaseDate, " | ") : text;
  const nm = withoutDate.match(/\d[\d,]{2,}/g) || [];
  let remainder = withoutDate;
  for (const n of nm) remainder = remainder.replace(n, " | ");
  remainder = remainder.replace(/[-▲▼]\s*\d*/g, " | ");
  const fallbackParts = remainder
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s && !/^[\d\s.\-●]+$/.test(s));

  return {
    primary_name: s2tConverter(fallbackParts[0] || ""),
    secondary_name: s2tConverter(fallbackParts.slice(1).join(" ") || ""),
    release_date: releaseDate,
    metric_value: metricValue,
    raw_text: rawText.slice(0, 300),
  };
}

// 把日期選擇器按鈕上的文字轉成 YYYYMMDD（取「結束日」）：
// 日榜是單一日期「8月 27, 2026」；週榜同月是「8月 14 – 20, 2026」；
// 週榜跨月是「7月 31 – 8月 6, 2026」；跨年格式沒有實測過，抓不到就回傳 null，讓呼叫端略過這筆
function parseDateLabelToYyyymmdd(text) {
  if (!text) return null;
  const t = text.trim();

  // 跨月／跨年週榜：兩段「N月 D」各自出現，取後面那段的年月日
  const crossMonth = t.match(/(\d{1,2})月\s*(\d{1,2}),?\s*(\d{4})?\s*[–-]\s*(\d{1,2})月\s*(\d{1,2}),?\s*(\d{4})/);
  if (crossMonth) {
    const [, , , , endMonth, endDay, endYear] = crossMonth;
    return `${endYear}${endMonth.padStart(2, "0")}${endDay.padStart(2, "0")}`;
  }

  // 同月週榜：「8月 14 – 20, 2026」，月份只出現一次，年份/月份套用到後面那個日
  const sameMonth = t.match(/(\d{1,2})月\s*\d{1,2}\s*[–-]\s*(\d{1,2}),?\s*(\d{4})/);
  if (sameMonth) {
    const [, month, endDay, year] = sameMonth;
    return `${year}${month.padStart(2, "0")}${endDay.padStart(2, "0")}`;
  }

  // 日榜單一日期：「8月 27, 2026」
  const single = t.match(/(\d{1,2})月\s*(\d{1,2}),?\s*(\d{4})/);
  if (single) {
    const [, month, day, year] = single;
    return `${year}${month.padStart(2, "0")}${day.padStart(2, "0")}`;
  }

  return null;
}

async function findLatestAnchorDate(page, pathName, cc, timeframe) {
  const url = buildUrl(pathName, cc, timeframe, null);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
  // 讀畫面上的日期選擇器按鈕文字（不是網址，這個網站是 SPA，網址列本身不會帶日期）
  const dateBtn = page.getByRole("button", { name: /月.*\d{4}/ });
  const text = await dateBtn
    .first()
    .textContent({ timeout: 20000 })
    .catch(() => null);
  return parseDateLabelToYyyymmdd(text);
}

function addDaysToYyyymmdd(yyyymmdd, deltaDays) {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const mo = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const dt = new Date(Date.UTC(y, mo, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

async function runCurrent(page, outDir, limitMarkets) {
  const today = taipeiDateString(0);
  const marketEntries = limitMarkets ? Object.entries(MARKETS).slice(0, limitMarkets) : Object.entries(MARKETS);

  for (const spec of CURRENT_CHARTS) {
    const allRows = [];
    for (const [cc, marketName] of marketEntries) {
      // 「發燒影片」沒有 Global 這個範圍，只有各國自己的版本，跳過避免無謂的失敗紀錄
      if (spec.key === "trending_videos" && cc === "global") continue;
      const url = buildUrl(spec.pathName, cc, spec.timeframe, null);
      console.log(`=== ${spec.key} / ${cc} : ${url} ===`, );
      try {
        const rows = await scrapeChart(page, url, {
          today,
          cc,
          marketName,
          chartKey: spec.key,
          dateSuffix: null,
        });
        allRows.push(...rows);
        console.log(`  -> ${rows.length} 筆`);
      } catch (e) {
        console.warn(`[warn] ${spec.key}/${cc} 失敗：${e.message}`);
      }
      await page.waitForTimeout(1200);
    }
    writeCsvWithBom(path.join(outDir, `youtube_${spec.key}_${today}.csv`), allRows);
    console.log(`[OK] ${spec.key}: 共 ${allRows.length} 筆`);
  }
}

// 回溯下限記錄檔：{ "top_songs_weekly_tw": "20260423", ... }
// 代表這個榜/這個市場，實測到這天（含）之前就沒有資料了，YouTube 那邊本來就沒有更早的期數，
// 不是爬蟲的問題。記下來之後，同一組合就不用每次重跑都再浪費請求去試更早的日期。
function floorFilePath(outDir) {
  return path.join(outDir, "_backfill_floor.json");
}

function loadBackfillFloors(outDir) {
  try {
    return JSON.parse(fs.readFileSync(floorFilePath(outDir), "utf8"));
  } catch {
    return {};
  }
}

function saveBackfillFloors(outDir, floors) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(floorFilePath(outDir), JSON.stringify(floors, null, 2), "utf8");
}

async function runBackfill(page, outDir, maxTargets) {
  const floors = loadBackfillFloors(outDir);
  const targets = [];
  // 安全上限：日榜約需 230 步、週榜約需 35 步就會先因為跳過 BACKFILL_TARGET_DATE 而停下，
  // 這個數字只是防呆用，避免日期算錯時無限迴圈
  const MAX_STEPS = 400;

  for (const spec of BACKFILLABLE_CHARTS) {
    const stepDays = spec.timeframe === "daily" ? 1 : 7;
    for (const [cc, marketName] of Object.entries(MARKETS)) {
      const floorKey = `${spec.key}_${cc}`;
      const knownFloor = floors[floorKey]; // 之前跑過、已經確認「這天之前沒資料」的下限（如果有的話）

      const anchor = await findLatestAnchorDate(page, spec.pathName, cc, spec.timeframe);
      if (!anchor) {
        console.warn(`[warn] ${spec.key}/${cc} 找不到目前最新一期的錨點，略過`);
        continue;
      }
      // 從錨點往回跳，跳到早於 BACKFILL_TARGET_DATE、或早於已知下限，就停
      for (let w = 1; w <= MAX_STEPS; w++) {
        const dateSuffix = addDaysToYyyymmdd(anchor, -stepDays * w);
        if (dateSuffix < BACKFILL_TARGET_DATE) break;
        if (knownFloor && dateSuffix <= knownFloor) break;
        const checkFile = path.join(outDir, `youtube_${spec.key}_${cc}_${dateSuffix}.csv`);
        if (fs.existsSync(checkFile)) continue;
        targets.push({ spec, cc, marketName, dateSuffix, floorKey });
      }
    }
  }

  const batch = targets.slice(0, maxTargets);
  const remaining = Math.max(0, targets.length - batch.length);
  console.log(`[backfill] 這次處理 ${batch.length} 組（還有 ${remaining} 組留到下次）`);
  if (remaining === 0 && batch.length === 0) {
    console.log(`[backfill] ✅ 全部抓完了——目前設定範圍內（回溯到 ${BACKFILL_TARGET_DATE}，或各市場實際的歷史下限）已經沒有新的資料可以抓，之後不用再手動觸發`);
  }

  const today = taipeiDateString(0);
  const hitFloorThisRun = new Set(); // 這次跑到才發現的下限，同一組合後面（更早的日期）不用再試
  let floorsChanged = false;

  for (const { spec, cc, marketName, dateSuffix, floorKey } of batch) {
    if (hitFloorThisRun.has(floorKey)) continue; // 這組已經在這次跑的過程中確認過沒資料了

    const url = buildUrl(spec.pathName, cc, spec.timeframe, dateSuffix);
    console.log(`=== backfill ${spec.key} / ${cc} / ${dateSuffix} : ${url} ===`);
    try {
      const rows = await scrapeChart(page, url, {
        today,
        cc,
        marketName,
        chartKey: spec.key,
        dateSuffix,
      });
      if (rows.length === 0) {
        // 這天真的沒資料（不是抓取失敗），代表往回已經到底了：記下下限，
        // 這組合更早的日期不用再試，這次跑不試，之後跑也不用再試
        console.warn(`[warn] ${spec.key}/${cc}/${dateSuffix} 抓到 0 筆，視為已到歷史資料下限，往回不再嘗試更早的日期`);
        floors[floorKey] = dateSuffix;
        floorsChanged = true;
        hitFloorThisRun.add(floorKey);
      } else {
        writeCsvWithBom(path.join(outDir, `youtube_${spec.key}_${cc}_${dateSuffix}.csv`), rows);
        console.log(`  -> ${rows.length} 筆`);
      }
    } catch (e) {
      console.warn(`[warn] backfill ${spec.key}/${cc}/${dateSuffix} 失敗：${e.message}`);
    }
    await page.waitForTimeout(1200);
  }

  if (floorsChanged) {
    saveBackfillFloors(outDir, floors);
    console.log(`[backfill] 更新了歷史資料下限記錄：${JSON.stringify(floors)}`);
  }
}

async function main() {
  const mode = process.argv.includes("--mode")
    ? process.argv[process.argv.indexOf("--mode") + 1]
    : "current";
  const outDir = "data";
  const maxTargetsArgIdx = process.argv.indexOf("--max-targets");
  // 加了 daily 榜之後回溯總量變大（6 種榜 x 10 市場 x 最多 230 天/33 週），
  // 預設值調高，避免要手動重跑幾百次才抓得完
  const maxTargets = maxTargetsArgIdx > -1 ? parseInt(process.argv[maxTargetsArgIdx + 1], 10) : 300;

  const browser = await chromium.launch();
  const context = await browser.newContext({
    locale: "zh-TW",
    viewport: { width: 1400, height: 1000 },
  });
  const page = await context.newPage();

  if (mode === "backfill") {
    await runBackfill(page, outDir, maxTargets);
  } else {
    await runCurrent(page, outDir);
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
