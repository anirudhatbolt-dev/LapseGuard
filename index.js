const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

// CORS preflight
app.options("/scrape", (req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.sendStatus(200);
});

app.post("/scrape", async (req, res) => {
  const { targetUrl, username, password } = req.body;

  // SSE headers
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders();

  const send = (type, payload) => {
    const data =
      type === "log"
        ? { type: "log", message: payload }
        : type === "result"
        ? { type: "result", data: payload }
        : { type: "done" };
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let browser;

  try {
    // ── 1. Launch ──────────────────────────────────────────────
    send("log", "Launching browser...");
    browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--single-process",
        ],
      });
    const page = await browser.newPage();

    // ── 2. Navigate to login ───────────────────────────────────
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    send("log", "Login page reached");
    await page.waitForTimeout(2000);

    // ── 3. Fill username ───────────────────────────────────────
    // Locate by placeholder or aria-label containing "user" (case-insensitive)
    const usernameInput = page.locator(
      'input[placeholder*="user" i], input[placeholder*="username" i], input[aria-label*="user" i], input[name*="user" i]'
    ).first();
    await usernameInput.fill(username);
    send("log", "Username entered");

    // ── 4. Fill password ───────────────────────────────────────
    const passwordInput = page.locator(
      'input[type="password"], input[placeholder*="password" i], input[aria-label*="password" i], input[name*="password" i]'
    ).first();
    await passwordInput.fill(password);
    send("log", "Password entered");

    // ── 5. Submit login ────────────────────────────────────────
    const loginButton = page.getByRole("button", {
      name: /login|sign in/i,
    });
    await loginButton.click();
    await page.waitForTimeout(3000);
    send("log", "Login submitted — waiting for dashboard");

    await page.waitForLoadState("networkidle").catch(() => {});
    send("log", "Dashboard reached");

    // ── 6. Navigate to Renewal Premium Report ─────────────────
    // Click the Reports nav link
    const reportsNav = page.getByRole("link", { name: /reports/i }).first();
    await reportsNav.click();
    await page.waitForTimeout(1000);
    send("log", "Reports menu opened");

    // Click dropdown item
    const renewalLink = page.getByRole("link", {
      name: /renewal premium report/i,
    });
    await renewalLink.click();
    await page.waitForTimeout(2000);
    send("log", "Renewal Premium Report page reached");

    // ── Helper: extract table rows for target columns ──────────
    async function extractRows(urgencyLabel) {
      // Read all headers
      const headers = await page.$$eval(
        "table thead th, table thead td",
        (ths) => ths.map((th) => th.innerText.trim())
      );

      const targetCols = [
        "Policy #",
        "Owner",
        "PTD",
        "Next Payment Date",
        "Mode Premium",
      ];
      const indices = targetCols.map((col) => {
        const idx = headers.findIndex(
          (h) => h.toLowerCase() === col.toLowerCase()
        );
        return idx;
      });

      const rows = await page.$$eval(
        "table tbody tr",
        (trs, { indices, targetCols, urgencyLabel }) => {
          return trs.map((tr) => {
            const cells = Array.from(
              tr.querySelectorAll("td")
            ).map((td) => td.innerText.trim());
            const row = { urgency: urgencyLabel };
            targetCols.forEach((col, i) => {
              row[col] = indices[i] !== -1 ? cells[indices[i]] ?? "" : "";
            });
            return row;
          });
        },
        { indices, targetCols, urgencyLabel }
      );

      return rows;
    }

    // ── PASS 1: PAST DUE ───────────────────────────────────────
    const pastDueBtn = page.getByRole("button", { name: /past due/i });
    await pastDueBtn.click();
    await page.waitForTimeout(1500);
    send("log", "Past Due filter applied");

    const pastDueRows = await extractRows("PAST DUE");
    send("log", `Past Due rows extracted: ${pastDueRows.length} rows`);

    // ── PASS 2: POTENTIAL LAPSE ────────────────────────────────
    const lapseBtnLocator = page.getByRole("button", {
      name: /potential lapse/i,
    });
    await lapseBtnLocator.click();
    await page.waitForTimeout(1500);
    send("log", "Potential Lapse filter applied");

    const lapseRows = await extractRows("POTENTIAL LAPSE");
    send("log", `Potential Lapse rows extracted: ${lapseRows.length} rows`);

    // ── COMBINE & DEDUPLICATE ──────────────────────────────────
    const policyMap = new Map();

    for (const row of pastDueRows) {
      policyMap.set(row["Policy #"], row);
    }
    // Potential Lapse overwrites duplicates (higher urgency)
    for (const row of lapseRows) {
      policyMap.set(row["Policy #"], row);
    }

    const combined = Array.from(policyMap.values());
    send("log", `Scrape complete. Total alerts: ${combined.length}`);

    // ── SEND RESULT ────────────────────────────────────────────
    send("result", combined);
    send("done");
  } catch (err) {
    send("log", `ERROR: ${err.message}`);
    send("done");
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Scraper listening on port ${PORT}`));