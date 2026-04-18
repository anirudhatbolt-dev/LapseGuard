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
    send("log", "Browser launched successfully");

    send("log", "Navigating to login page...");
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    send("log", "Login page reached");
    await page.waitForTimeout(5000);

    send("log", "Looking for username field...");
    const usernameInput = page.locator(
      'input[placeholder*="user" i], input[placeholder*="username" i], input[aria-label*="user" i], input[name*="user" i]'
    ).first();
    await usernameInput.waitFor({ timeout: 10000 });
    await usernameInput.fill(username);
    send("log", `Username entered: ${username}`);
    await page.waitForTimeout(1000);

    send("log", "Looking for password field...");
    const passwordInput = page.locator(
      'input[type="password"], input[placeholder*="password" i], input[aria-label*="password" i], input[name*="password" i]'
    ).first();
    await passwordInput.waitFor({ timeout: 10000 });
    await passwordInput.fill(password);
    send("log", "Password entered");
    await page.waitForTimeout(1000);

    send("log", "Looking for login button...");
    const loginButton = page.getByRole("button", { name: /login|sign in/i });
    await loginButton.waitFor({ timeout: 10000 });
    await loginButton.click();
    send("log", "Login submitted — waiting for dashboard...");
    await page.waitForTimeout(5000);

    await page.waitForLoadState("networkidle").catch(() => {});
    send("log", `Dashboard reached — URL: ${page.url()}`);
    await page.waitForTimeout(3000);

    send("log", "Looking for Reports nav link...");
    const reportsNav = page.getByRole("link", { name: /reports/i }).first();
    await reportsNav.waitFor({ timeout: 10000 });
    await reportsNav.click();
    send("log", "Reports menu clicked");
    await page.waitForTimeout(3000);

    send("log", "Looking for Renewal Premium Report...");
    const renewalLink = page.getByRole("link", {
      name: /renewal premium report/i,
    });
    await renewalLink.waitFor({ timeout: 10000 });
    await renewalLink.click();
    send("log", "Renewal Premium Report clicked");
    await page.waitForTimeout(5000);
    send("log", `Report page reached — URL: ${page.url()}`);

    async function extractRows(urgencyLabel) {
      const headers = await page.$$eval(
        "table thead th, table thead td",
        (ths) => ths.map((th) => th.innerText.trim())
      );
      send("log", `Table headers found: ${headers.join(", ")}`);

      const targetCols = ["Policy #", "Owner", "PTD", "Next Payment Date", "Mode Premium"];
      const indices = targetCols.map((col) =>
        headers.findIndex((h) => h.toLowerCase() === col.toLowerCase())
      );

      const rows = await page.$$eval(
        "table tbody tr",
        (trs, { indices, targetCols, urgencyLabel }) => {
          return trs.map((tr) => {
            const cells = Array.from(tr.querySelectorAll("td")).map((td) =>
              td.innerText.trim()
            );
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

    send("log", "Looking for PAST DUE button...");
    const pastDueBtn = page.getByRole("button", { name: /past due/i });
    await pastDueBtn.waitFor({ timeout: 10000 });
    await pastDueBtn.click();
    send("log", "Past Due filter applied");
    await page.waitForTimeout(4000);

    const pastDueRows = await extractRows("PAST DUE");
    send("log", `Past Due rows extracted: ${pastDueRows.length} rows`);

    send("log", "Looking for POTENTIAL LAPSE button...");
    const lapseBtn = page.getByRole("button", { name: /potential lapse/i });
    await lapseBtn.waitFor({ timeout: 10000 });
    await lapseBtn.click();
    send("log", "Potential Lapse filter applied");
    await page.waitForTimeout(4000);

    const lapseRows = await extractRows("POTENTIAL LAPSE");
    send("log", `Potential Lapse rows extracted: ${lapseRows.length} rows`);

    send("log", "Merging and deduplicating results...");
    const policyMap = new Map();
    for (const row of pastDueRows) policyMap.set(row["Policy #"], row);
    for (const row of lapseRows) policyMap.set(row["Policy #"], row);
    const combined = Array.from(policyMap.values());

    send("log", `Scrape complete — Total alerts: ${combined.length}`);
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