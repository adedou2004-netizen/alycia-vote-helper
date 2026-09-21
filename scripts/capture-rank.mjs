import { chromium } from "playwright";

const GROUP_FALLBACK = "https://thesuperkid.org/browse/2026/group-16dac5ff";
const PROFILE = "https://thesuperkid.org/2026/alycia-5613";
const SUPABASE_URL = "https://dbqrenlvinqheyjppxby.supabase.co";
const TOKEN = process.env.ALYCIA_CAPTURE_TOKEN;
const FORCE = process.argv.includes("--force");

function torontoParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date()).reduce((a,p)=>(a[p.type]=p.value,a),{});
  return parts;
}

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
  for (let i=0; i<25 && stable<4; i++) {
    const more = page.getByRole("button", { name: /load more|show more|more/i }).first();
    if (await more.count()) {
      try { if (await more.isVisible()) await more.click({ timeout: 1500 }); } catch {}
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastHeight) stable++; else stable = 0;
    lastHeight = h;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function getLiveAlyciaRank(page) {
  await page.goto(PROFILE, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1800);
  const body = await page.locator("body").innerText();
  const m = body.match(/Currently\s+(\d+)(?:st|nd|rd|th)?\s+in\s+their\s+Group/i)
    || body.match(/Currently\s+(\d+)(?:st|nd|rd|th)?/i);
  if (!m) throw new Error("Could not read Alycia's live rank from profile");
  const groupHref = await page.locator('a[href*="/browse/2026/group-"]').first().getAttribute("href").catch(()=>null);
  return { rank: Number(m[1]), groupHref };
}

async function extractGroup(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2200);
  await scrollAndExpand(page);
  await page.screenshot({ path: "capture-evidence.png", fullPage: true });

  const items = await page.locator('a[href*="/2026/"]').evaluateAll((anchors) => {
    const seen = new Map();
    for (const a of anchors) {
      const href = a.href;
      if (!href || href.includes("/browse/") || href.includes("/rules") || href.includes("/faq")) continue;
      if (!/^https:\/\/thesuperkid\.org\/2026\/[A-Za-z0-9_-]+\/?(?:\?.*)?$/.test(href)) continue;
      let name = (a.textContent || "").trim().replace(/\s+/g, " ");
      if (!name) {
        const img = a.querySelector("img");
        name = (img?.getAttribute("alt") || "").trim().replace(/\s+/g, " ");
      }
      const clean = href.split("?")[0].replace(/\/$/, "");
      const existing = seen.get(clean);
      if (!existing) seen.set(clean, { profile_url: clean, contestant_name: name });
      else if (!existing.contestant_name && name) existing.contestant_name = name;
    }
    return [...seen.values()];
  });

  const filtered = items
    .map(x => ({...x, contestant_name: x.contestant_name.replace(/\s*(Vote|View Profile).*$/i,"").trim()}))
    .filter(x => x.contestant_name && x.contestant_name.length <= 100);

  if (filtered.length < 20) throw new Error(`Only ${filtered.length} contestants were extracted; refusing partial snapshot`);

  return filtered.map((x, i) => ({ ...x, rank: i + 1 }));
}

async function main() {
  const t = torontoParts();
  if (!TOKEN) throw new Error("GitHub secret ALYCIA_CAPTURE_TOKEN is not configured");
  if (FORCE && Number(t.hour) !== 15) {
    console.log(`Scheduled/manual capture started at Toronto time ${t.hour}:${t.minute}; continuing instead of skipping.`);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36"
  });
  const page = await context.newPage();

  try {
    const live = await getLiveAlyciaRank(page);
    let groupUrl = GROUP_FALLBACK;

    if (live.groupHref) {
      groupUrl = new URL(live.groupHref, PROFILE).href;
    } else {
      console.log("Profile did not expose group link; trying known group URL.");
    }

    let contestants = await extractGroup(page, groupUrl);
    let alycia = contestants.find(x => x.contestant_name.trim().toLowerCase() === "alycia");

    if (!alycia && groupUrl !== GROUP_FALLBACK) {
      contestants = await extractGroup(page, GROUP_FALLBACK);
      groupUrl = GROUP_FALLBACK;
      alycia = contestants.find(x => x.contestant_name.trim().toLowerCase() === "alycia");
    }

    if (!alycia) throw new Error("Alycia was not found in the extracted group");
    if (alycia.rank !== live.rank) {
      throw new Error(`Rank verification failed: profile says #${live.rank}, extracted group says #${alycia.rank}`);
    }

    const captured_at = new Date().toISOString();
    const saved = await saveSnapshot({
      captured_at,
      source_url: groupUrl,
      contestants,
      alycia_rank: live.rank
    });

    if (saved.row_count !== contestants.length || saved.alycia_rank !== live.rank) {
      throw new Error("Database verification response did not match the live capture");
    }

    console.log(`SUCCESS: saved ${saved.row_count} contestants; Alycia #${saved.alycia_rank}; ${saved.captured_at}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("CAPTURE FAILED:", msg);
    try { await page.screenshot({ path: "capture-failure.png", fullPage: true }); } catch {}
    try {
      await sendAlert(`Alycia 3 PM ranking capture failed: ${msg.slice(0, 300)} Please check the group manually.`);
    } catch (smsErr) {
      console.error("Could not send SMS alert:", smsErr);
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
