import { chromium } from "playwright";

const GROUP_URL = "https://thesuperkid.org/browse/2026/group-16dac5ff";
const PROFILE = "https://thesuperkid.org/2026/alycia-5613";
const SUPABASE_URL = "https://dbqrenlvinqheyjppxby.supabase.co";
const TOKEN = process.env.ALYCIA_CAPTURE_TOKEN;

// The 10 contestants who advanced at the Oct 1, 2026 10:00 p.m. Toronto cutoff.
// Eliminated contestants remain visible on the SuperKid page, so snapshots
// filter to this fixed Top 10 and rank only these contestants.
const ACTIVE_TOP_10 = new Set([
  "https://thesuperkid.org/2026/mason-da49",
  "https://thesuperkid.org/2026/hunter-2c40",
  "https://thesuperkid.org/2026/jameson-2b6a",
  "https://thesuperkid.org/2026/alycia-5613",
  "https://thesuperkid.org/2026/kai-f690",
  "https://thesuperkid.org/2026/kirby-285a",
  "https://thesuperkid.org/2026/alexander-99ec",
  "https://thesuperkid.org/2026/tristan-5092",
  "https://thesuperkid.org/2026/trey-c5ce",
  "https://thesuperkid.org/2026/keelan-64d0"
]);

async function sendAlert(message) {
  if (!TOKEN) throw new Error("Missing ALYCIA_CAPTURE_TOKEN");
  const r = await fetch(`${SUPABASE_URL}/functions/v1/alycia-sms-alert`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-capture-token": TOKEN },
    body: JSON.stringify({ message })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`SMS alert failed (${r.status}): ${text}`);
  console.log("SMS alert sent:", text);
}

async function saveSnapshot(payload) {
  if (!TOKEN) throw new Error("Missing ALYCIA_CAPTURE_TOKEN");
  const r = await fetch(`${SUPABASE_URL}/functions/v1/alycia-rank-ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-capture-token": TOKEN },
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Snapshot save failed (${r.status}): ${text}`);
  return JSON.parse(text);
}

async function scrollAndExpand(page) {
  let stable = 0;
  let lastHeight = 0;
  for (let i = 0; i < 25 && stable < 4; i++) {
    const more = page.getByRole("button", { name: /load more|show more|more/i }).first();
    if (await more.count()) {
      try {
        if (await more.isVisible()) await more.click({ timeout: 1500 });
      } catch {}
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastHeight) stable++;
    else stable = 0;
    lastHeight = h;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function getLiveAlyciaRank(page) {
  await page.goto(PROFILE, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1800);
  const body = await page.locator("body").innerText();
  const m =
    body.match(/Currently\s+(\d+)(?:st|nd|rd|th)?\s+in\s+their\s+Group/i) ||
    body.match(/Currently\s+(\d+)(?:st|nd|rd|th)?/i);
  if (!m) throw new Error("Could not read Alycia's live rank from profile");
  return Number(m[1]);
}

async function extractTop10(page) {
  await page.goto(GROUP_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2200);
  await scrollAndExpand(page);
  const items = await page.locator('a[href*="/2026/"]').evaluateAll((anchors) => {
    const seen = new Map();
    for (const a of anchors) {
      const href = a.href;
      if (!href || href.includes("/browse/") || href.includes("/rules") || href.includes("/faq")) continue;
      if (!/^https:\/\/thesuperkid\.org\/2026\/[A-Za-z0-9_-]+\/?(?:\?.*)?$/.test(href)) continue;

      const clean = href.split("?")[0].replace(/\/$/, "");
      let name = (a.textContent || "").trim().replace(/\s+/g, " ");
      if (!name) {
        const img = a.querySelector("img");
        name = (img?.getAttribute("alt") || "").trim().replace(/\s+/g, " ");
      }

      const existing = seen.get(clean);
      if (!existing) seen.set(clean, { profile_url: clean, contestant_name: name });
      else if (!existing.contestant_name && name) existing.contestant_name = name;
    }
    return [...seen.values()];
  });

  const top10 = items
    .map(x => ({
      ...x,
      contestant_name: x.contestant_name.replace(/\s*(Vote|View Profile).*$/i, "").trim()
    }))
    .filter(x => ACTIVE_TOP_10.has(x.profile_url));

  if (top10.length !== ACTIVE_TOP_10.size) {
    const found = new Set(top10.map(x => x.profile_url));
    const missing = [...ACTIVE_TOP_10].filter(url => !found.has(url));
    throw new Error(
      `Expected all ${ACTIVE_TOP_10.size} Top-10 contestants but found ${top10.length}. Missing: ${missing.join(", ")}`
    );
  }

  return top10.map((x, i) => ({ ...x, rank: i + 1 }));
}

async function main() {
  if (!TOKEN) throw new Error("GitHub secret ALYCIA_CAPTURE_TOKEN is not configured");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36"
  });
  const page = await context.newPage();

  try {
    const liveRank = await getLiveAlyciaRank(page);
    const contestants = await extractTop10(page);
    const alycia = contestants.find(x => x.profile_url === PROFILE);

    if (!alycia) throw new Error("Alycia was not found among the fixed Top 10");
    if (alycia.rank !== liveRank) {
      throw new Error(
        `Rank verification failed: profile says #${liveRank}, filtered Top-10 order says #${alycia.rank}`
      );
    }

    const captured_at = new Date().toISOString();
    const saved = await saveSnapshot({
      captured_at,
      source_url: GROUP_URL,
      contestants,
      alycia_rank: liveRank
    });

    if (saved.row_count !== ACTIVE_TOP_10.size || saved.alycia_rank !== liveRank) {
      throw new Error("Database verification response did not match the Top-10 capture");
    }

    console.log(
      `SUCCESS: saved ${saved.row_count} Top-10 contestants; Alycia #${saved.alycia_rank}; ${saved.captured_at}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("CAPTURE FAILED:", msg);
    try {
      await page.screenshot({ path: "capture-failure.png", fullPage: true });
    } catch {}
    try {
      await sendAlert(
        `Alycia hourly ranking capture failed: ${msg.slice(0, 300)} Please check the group manually.`
      );
    } catch (smsErr) {
      console.error("Could not send SMS alert:", smsErr);
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
