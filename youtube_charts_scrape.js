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
  const snap = await page.accessibility.snapshot({ interestingOnly: false }).catch(() => null);
  fs.writeFileSync(`debug/${label}.json`, JSON.stringify(snap, null, 2), "utf8");
}

// 把無障礙輔助樹攤平成一串文字節點，方便照順序掃描
function flattenTextNodes(node, out = []) {
  if (!node) return out;
  if (node.name && typeof node.name === "string" && node.name.trim()) {
    out.push({ role: node.role, name: node.name.trim() });
  }
  if (node.children) {
    for (const child of node.children) flattenTextNodes(child, out);
  }
  return out;
}

// 找出所有「縮圖」節點的位置，當作每一列榜單的分界點，
// 兩個縮圖之間出現的文字節點，就是同一列的內容
function segmentRows(flatNodes) {
  const thumbIndices = [];
  flatNodes.forEach((n, i) => {
    if (n.role === "image" && /thumbnail|封面|縮圖/.test(n.name)) thumbIndices.push(i);
  });
  if (!thumbIndices.length) return [];

  const segments = [];
  for (let i = 0; i < thumbIndices.length; i++) {
    const start = thumbIndices[i] + 1;
    const end = i + 1 < thumbIndices.length ? thumbIndices[i + 1] : flatNodes.length;
    segments.push(flatNodes.slice(start, end));
  }
  return segments;
}

function classifySegment(segment) {
  const texts = segment.map((n) => n.name).filter(Boolean);
  let releaseDate = null;
  let metricValue = null;
  const remaining = [];

  for (const t of texts) {
    if (!releaseDate && DATE_PATTERN.test(t)) {
      releaseDate = t;
      continue;
    }
    if (!metricValue && PURE_NUMBER_PATTERN.test(t.replace(/\s/g, ""))) {
      metricValue = t.replace(/,/g, "");
      continue;
    }
    remaining.push(t);
  }

  // remaining 第一段通常是標題／藝人名，第二段（若有）通常是合作藝人／副標
  const primaryName = remaining[0] || "";
  const secondaryName = remaining.slice(1).join(" ") || "";

  return {
    primary_name: primaryName,
    secondary_name: secondaryName,
    release_date: releaseDate || "",
    metric_value: metricValue || "",
    raw_text: texts.join(" | ").slice(0, 300),
  };
}

async function scrapeChart(page, url, ctx) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });

  // 榜單資料是背景載入的，等到看得見縮圖為止，比等待某段文字更保險
  const ready = await page
    .waitForFunction(
      () => document.querySelectorAll("img").length > 5,
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);

  if (!ready) {
    await debugCapture(page, `${ctx.cc}_${ctx.chartKey}${ctx.dateSuffix ? "_" + ctx.dateSuffix : ""}`);
    return [];
  }

  await page.waitForTimeout(1000);

  const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
  const flat = flattenTextNodes(snapshot);
  const segments = segmentRows(flat);

  if (!segments.length) {
    await debugCapture(page, `${ctx.cc}_${ctx.chartKey}${ctx.dateSuffix ? "_" + ctx.dateSuffix : ""}`);
    return [];
  }

  return segments.map((seg, i) => {
    const parsed = classifySegment(seg);
    return {
      captured_date: ctx.today,
      market: ctx.cc,
      market_name: ctx.marketName,
      chart: ctx.chartKey,
      period_suffix: ctx.dateSuffix || "",
      rank: i + 1,
      ...parsed,
    };
  });
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
