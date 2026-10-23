import { chromium } from "playwright";

const GROUP_URL = "https://thesuperkid.org/browse/2026/group-16dac5ff";
const PROFILE = "https://thesuperkid.org/2026/alycia-5613";
const SUPABASE_URL = "https://dbqrenlvinqheyjppxby.supabase.co";
const TOKEN = process.env.ALYCIA_CAPTURE_TOKEN;

// Wild Card is a new mixed-origin group of exactly four contestants.
// Discover the current group from Alycia's profile, never her former group.
const WILDCARD_SIZE = 4;

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

async function discoverWildcard(page) {
  await page.goto(PROFILE, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2200);
  const body = await page.locator("body").innerText();
  if (!/Wildcard/i.test(body)) throw new Error("Alycia's profile does not show Wild Card yet");
  const m = body.match(/Currently\\s+(\\d+)(?:st|nd|rd|th)?\\s+in\\s+the\\s+Wildcards/i)
    || body.match(/Currently\\s+(\\d+)(?:st|nd|rd|th)?/i);
  if (!m) throw new Error("Could not read Alycia's Wild Card rank");
  const liveRank = Number(m[1]);
  if (liveRank < 1 || liveRank > WILDCARD_SIZE) throw new Error("Invalid Wild Card rank: " + liveRank);
  const groupLinks = await page.locator('a[href*="/browse/2026/"]').evaluateAll(anchors =>
    [...new Set(anchors.map(a => a.href).filter(h => /\\/browse\\/2026\\/(?:group-|wildcard)/i.test(h))) ]);
  if (groupLinks.length !== 1) throw new Error("Expected one current group link on Alycia's profile; found " + groupLinks.length + ". Do not use her former group URL.");
  return { liveRank, groupUrl: groupLinks[0] };
}

async function extractWildcard(page, groupUrl) {
  await page.goto(groupUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2200);
  await scrollAndExpand(page);
  const items = await page.locator('a[href*="/2026/"]').evaluateAll(anchors => {
    const seen = new Map();
    for (const a of anchors) {
      const href = a.href;
      if (!/^https:\\/\\/thesuperkid\\.org\\/2026\\/[A-Za-z0-9_-]+\\/?(?:\\?.*)?$/.test(href)) continue;
      const clean = href.split("?")[0].replace(/\\/$/, "");
      let name = (a.textContent || "").trim().replace(/\\s+/g, " ");
      if (!name) name = (a.querySelector("img")?.getAttribute("alt") || "").trim().replace(/\\s+/g, " ");
      name = name.replace(/\\s*(Vote|View Profile).*$/i, "").trim();
      if (!seen.has(clean)) seen.set(clean, { profile_url: clean, contestant_name: name });
      else if (!seen.get(clean).contestant_name && name) seen.get(clean).contestant_name = name;
    }
    return [...seen.values()];
  });
  if (items.length !== WILDCARD_SIZE || !items.some(x => x.profile_url === PROFILE)) {
    throw new Error(`Expected a four-person Wild Card group including Alycia, but found ${items.length} profile links. Refusing to save incorrect rankings.`);
  }
  const result = items.map((x,i) => ({ ...x, contestant_name: x.profile_url===PROFILE ? "Alycia" : x.contestant_name, rank:i+1 }));
  if (result.some(x => !x.contestant_name)) throw new Error("One or more Wild Card contestant names were missing");
  return result;
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
    const contestants = await extractTop15(page);
    const alycia = contestants.find(x => x.profile_url === PROFILE);

    if (!alycia) throw new Error("Alycia was not found in the Wild Card group");
    if (alycia.rank !== liveRank) {
      throw new Error(
        `Rank verification failed: profile says #${liveRank}, four-person Wild Card order says #${alycia.rank}`
      );
    }

    const captured_at = new Date().toISOString();
    const saved = await saveSnapshot({
      captured_at,
      source_url: groupUrl,
      contestants,
      alycia_rank: liveRank
    });

    if (saved.row_count !== WILDCARD_SIZE || saved.alycia_rank !== liveRank) {
      throw new Error("Database verification response did not match the Top-15 capture");
    }

    console.log(
      `SUCCESS: saved ${saved.row_count} Wild Card contestants; Alycia #${saved.alycia_rank}; ${saved.captured_at}`
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
