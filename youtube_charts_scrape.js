// YouTube Music Charts 爬蟲：TrendingVideos / TopVideos(日+週) / TopSongs(週) / TopArtists(週)
// 資料來源：charts.youtube.com（不需登入）
// 技術備註：這個網站的榜單內容放在 Shadow DOM 裡，一般 DOM 選擇器讀不到，
// 改用瀏覽器的無障礙輔助樹（accessibility tree）讀取畫面上實際顯示的文字，
// 再照內容樣式（日期格式、純數字）去分類是標題、藝人名、日期還是觀看數。
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

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

// 可以回溯歷史的榜（週榜，網址帶 YYYYMMDD 往回跳 7 天）
const BACKFILLABLE_CHARTS = [
  { key: "top_songs_weekly", pathName: "TopSongs" },
  { key: "top_artists_weekly", pathName: "TopArtists" },
];

const DATE_PATTERN = /\d{1,2}\s*月\s*\d{1,2},?\s*\d{4}/;
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

  const isRankBadge = (s) => /^[-▲▼]?\s*\d{0,3}$/.test(s) || /^New$/i.test(s);
  const isDateStr = (s) => DATE_PATTERN.test(s);
  const isPureNumber = (s) => PURE_NUMBER_PATTERN.test(s.replace(/,/g, ""));

  const numberMatches = rawText.match(/\d[\d,]{2,}/g) || [];
  const metricValue = numberMatches.length ? numberMatches[numberMatches.length - 1].replace(/,/g, "") : "";

  // 優先用「元素邊界」分出的 parts 判斷標題／藝人名，
  // 這比用數字/日期的位置去猜邊界準確，因為多數列根本沒有數字或日期可以當分界點
  const nameParts = parts.filter((p) => !isRankBadge(p) && !isDateStr(p) && !isPureNumber(p));

  if (nameParts.length >= 2) {
    return {
      primary_name: nameParts[0],
      secondary_name: nameParts.slice(1).join(" / "),
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
    primary_name: fallbackParts[0] || "",
    secondary_name: fallbackParts.slice(1).join(" ") || "",
    release_date: releaseDate,
    metric_value: metricValue,
    raw_text: rawText.slice(0, 300),
  };
}

async function findLatestAnchorDate(page, pathName, cc) {
  const url = buildUrl(pathName, cc, "weekly", null);
  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => null);
  await page.waitForTimeout(1500);
  const finalUrl = page.url();
  const m = finalUrl.match(/(\d{8})$/);
  return m ? m[1] : null;
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

async function runBackfill(page, outDir, maxTargets) {
  const targets = [];

  for (const spec of BACKFILLABLE_CHARTS) {
    for (const [cc, marketName] of Object.entries(MARKETS)) {
      const anchor = await findLatestAnchorDate(page, spec.pathName, cc);
      if (!anchor) {
        console.warn(`[warn] ${spec.key}/${cc} 找不到目前最新的週次錨點，略過`);
        continue;
      }
      // 往回最多 15 週（跟畫面上下拉選單能選到的範圍差不多）
      for (let w = 1; w <= 15; w++) {
        const dateSuffix = addDaysToYyyymmdd(anchor, -7 * w);
        const checkFile = path.join(outDir, `youtube_${spec.key}_${cc}_${dateSuffix}.csv`);
        if (fs.existsSync(checkFile)) continue;
        targets.push({ spec, cc, marketName, dateSuffix });
      }
    }
  }

  const batch = targets.slice(0, maxTargets);
  console.log(`[backfill] 這次處理 ${batch.length} 組（還有 ${Math.max(0, targets.length - batch.length)} 組留到下次）`);

  const today = taipeiDateString(0);
  for (const { spec, cc, marketName, dateSuffix } of batch) {
    const url = buildUrl(spec.pathName, cc, "weekly", dateSuffix);
    console.log(`=== backfill ${spec.key} / ${cc} / ${dateSuffix} : ${url} ===`);
    try {
      const rows = await scrapeChart(page, url, {
        today,
        cc,
        marketName,
        chartKey: spec.key,
        dateSuffix,
      });
      writeCsvWithBom(path.join(outDir, `youtube_${spec.key}_${cc}_${dateSuffix}.csv`), rows);
      console.log(`  -> ${rows.length} 筆`);
    } catch (e) {
      console.warn(`[warn] backfill ${spec.key}/${cc}/${dateSuffix} 失敗：${e.message}`);
    }
    await page.waitForTimeout(1200);
  }
}

async function main() {
  const mode = process.argv.includes("--mode")
    ? process.argv[process.argv.indexOf("--mode") + 1]
    : "current";
  const outDir = "data";
  const maxTargetsArgIdx = process.argv.indexOf("--max-targets");
  const maxTargets = maxTargetsArgIdx > -1 ? parseInt(process.argv[maxTargetsArgIdx + 1], 10) : 10;

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
