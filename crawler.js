#!/usr/bin/env node

/**
 * Playwright SEO Spider — Screaming Frog-style web crawler
 * Usage: node crawler.js <url> [options]
 *
 * Options:
 *   --max-pages  <n>     Stop after crawling n pages (default: 200)
 *   --concurrency <n>    Parallel browser tabs (default: 3)
 *   --same-domain        Only follow links on the same domain (default: true)
 *   --same-path          Only follow links under the starting URL path (default: false)
 *   --include-ext        Comma-separated extra extensions to crawl (e.g. .php)
 *   --output <file>      Write CSV report to file
 *   --timeout <ms>       Navigation timeout per page (default: 15000)
 *   --no-headless        Show browser window while crawling
 *   --ignore-https-errors Ignore HTTPS/SSL certificate errors (default: true)
 *   --snapshot-on-timeout Take screenshot & HTML snapshot of pages that timeout (default: false)
 *   --login-url  <url>   Login page URL to authenticate first
 *   --username   <str>   Username / email for automatic login
 *   --password   <str>   Password for automatic login
 *   --user-selector <sel> CSS selector for the username input
 *   --pass-selector <sel> CSS selector for the password input
 *   --submit-selector <sel> CSS selector for the login submit button
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const url = require("url");

// ─────────────────────────────────────────────
//  CLI argument parsing
// ─────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    startUrl: null,
    maxPages: 200,
    concurrency: 3,
    sameDomain: true,
    samePath: false,
    includeExt: [],
    output: null,
    timeout: 15000,
    headless: true,
    ignoreHttpsErrors: true,
    snapshotOnTimeout: false,
    loginUrl: null,
    username: null,
    password: null,
    userSelector: null,
    passSelector: null,
    submitSelector: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { opts.startUrl = a; continue; }
    switch (a) {
      case "--max-pages":    opts.maxPages    = parseInt(args[++i], 10); break;
      case "--concurrency":  opts.concurrency = parseInt(args[++i], 10); break;
      case "--same-domain":  opts.sameDomain  = true; break;
      case "--no-same-domain": opts.sameDomain = false; break;
      case "--same-path":    opts.samePath    = true; break;
      case "--include-ext":  opts.includeExt  = args[++i].split(","); break;
      case "--output":       opts.output      = args[++i]; break;
      case "--timeout":      opts.timeout     = parseInt(args[++i], 10); break;
      case "--no-headless":  opts.headless    = false; break;
      case "--ignore-https-errors": opts.ignoreHttpsErrors = true; break;
      case "--no-ignore-https-errors": opts.ignoreHttpsErrors = false; break;
      case "--snapshot-on-timeout": opts.snapshotOnTimeout = true; break;
      case "--login-url":       opts.loginUrl       = args[++i]; break;
      case "--username":        opts.username        = args[++i]; break;
      case "--password":        opts.password        = args[++i]; break;
      case "--user-selector":   opts.userSelector   = args[++i]; break;
      case "--pass-selector":   opts.passSelector   = args[++i]; break;
      case "--submit-selector": opts.submitSelector = args[++i]; break;
      default: console.warn(`Unknown option: ${a}`);
    }
  }

  if (!opts.startUrl) {
    console.error("Usage: node crawler.js <url> [options]");
    process.exit(1);
  }

  // Normalise start URL
  if (!/^https?:\/\//i.test(opts.startUrl)) {
    opts.startUrl = "https://" + opts.startUrl;
  }

  return opts;
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

// Extensions we consider "crawlable HTML pages"
const HTML_EXTS = new Set([".html", ".htm", ".php", ".asp", ".aspx", ".jsp", ""]);

// Extensions we always skip (binary / non-page assets)
const SKIP_EXTS = new Set([
  ".jpg",".jpeg",".png",".gif",".webp",".svg",".ico",
  ".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",
  ".zip",".tar",".gz",".rar",".7z",
  ".mp4",".mp3",".webm",".ogg",".wav",
  ".css",".js",".json",".xml",".txt",".csv",
  ".woff",".woff2",".ttf",".eot",
]);

function isHtmlUrl(rawUrl, extraExts = []) {
  try {
    const u = new URL(rawUrl);
    const p = u.pathname.toLowerCase();
    const ext = path.extname(p);
    if (SKIP_EXTS.has(ext)) return false;
    if (extraExts.includes(ext)) return true;
    return HTML_EXTS.has(ext);
  } catch {
    return false;
  }
}

function normalise(rawUrl, base) {
  try {
    const u = new URL(rawUrl, base);
    u.hash = "";          // strip fragment
    u.search = u.search;  // keep query string
    return u.href;
  } catch {
    return null;
  }
}

function sameDomain(a, b) {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

function samePath(targetUrl, startUrl) {
  try {
    const target = new URL(targetUrl);
    const start = new URL(startUrl);
    if (target.hostname !== start.hostname) return false;

    let startPath = start.pathname;
    let targetPath = target.pathname;

    // Normalise trailing slashes for comparison
    if (startPath.endsWith("/")) startPath = startPath.slice(0, -1);
    if (targetPath.endsWith("/")) targetPath = targetPath.slice(0, -1);

    if (targetPath === startPath) return true;

    // Must be a subpath (e.g. /en-ca/about matches /en-ca)
    return targetPath.startsWith(startPath + "/");
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
//  Terminal colour helpers (no deps)
// ─────────────────────────────────────────────
const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  blue:   "\x1b[34m",
  white:  "\x1b[37m",
  grey:   "\x1b[90m",
};

function statusColour(code) {
  if (!code)            return c.grey;
  if (code < 300)       return c.green;
  if (code < 400)       return c.yellow;
  if (code < 500)       return c.red;
  return c.red;
}

function pad(s, n) {
  return String(s).padEnd(n).slice(0, n);
}

function printHeader(startUrl) {
  console.log();
  console.log(c.bold + c.cyan + "  ╔══════════════════════════════════════════╗" + c.reset);
  console.log(c.bold + c.cyan + "  ║     🕷  Playwright SEO Spider Crawler     ║" + c.reset);
  console.log(c.bold + c.cyan + "  ╚══════════════════════════════════════════╝" + c.reset);
  console.log(c.dim  + `  Target : ${startUrl}` + c.reset);
  console.log();
}

function printTableHeader() {
  console.log(
    c.bold +
    "  " +
    pad("#",    5)  +
    pad("Status", 8) +
    pad("Links", 7) +
    "URL" +
    c.reset
  );
  console.log(c.grey + "  " + "─".repeat(80) + c.reset);
}

function printRow(index, result) {
  const sc = statusColour(result.status);
  console.log(
    "  " +
    c.grey  + pad(index, 5)          + c.reset +
    sc      + pad(result.status || "ERR", 8) + c.reset +
    c.dim   + pad(result.linksFound, 7) + c.reset +
    c.white + result.url.slice(0, 100) + c.reset
  );
}

function printProgress(crawled, queued, errors) {
  process.stdout.write(
    `\r  ${c.bold}${c.green}Crawled: ${crawled}${c.reset}` +
    `  ${c.yellow}Queued: ${queued}${c.reset}` +
    `  ${c.red}Errors: ${errors}${c.reset}    `
  );
}

// ─────────────────────────────────────────────
//  Summary table
// ─────────────────────────────────────────────
function printSummary(results, startMs) {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const total   = results.length;
  const ok      = results.filter(r => r.status >= 200 && r.status < 300).length;
  const redir   = results.filter(r => r.status >= 300 && r.status < 400).length;
  const err4    = results.filter(r => r.status >= 400 && r.status < 500).length;
  const err5    = results.filter(r => r.status >= 500).length;
  const errNet  = results.filter(r => !r.status).length;

  console.log("\n");
  console.log(c.bold + c.cyan + "  ══════════════  CRAWL SUMMARY  ══════════════" + c.reset);
  console.log();
  console.log(`  ${c.bold}Total pages crawled :${c.reset}  ${c.green}${c.bold}${total}${c.reset}`);
  console.log(`  ${c.bold}Total crawlable URLs:${c.reset}  ${c.cyan}${c.bold}${total + 0}${c.reset}  (unique, same-domain)`);
  console.log();
  console.log(`  ${c.green}2xx OK          :${c.reset}  ${ok}`);
  console.log(`  ${c.yellow}3xx Redirects   :${c.reset}  ${redir}`);
  console.log(`  ${c.red}4xx Client Err  :${c.reset}  ${err4}`);
  console.log(`  ${c.red}5xx Server Err  :${c.reset}  ${err5}`);
  console.log(`  ${c.grey}Network Errors  :${c.reset}  ${errNet}`);
  console.log();
  console.log(`  Elapsed time    :  ${elapsed}s`);
  console.log(c.grey + "  " + "═".repeat(47) + c.reset);
  console.log();
}

// ─────────────────────────────────────────────
//  CSV export
// ─────────────────────────────────────────────
function writeCsv(filepath, results) {
  const header = "index,url,status,title,h1,links_found,load_ms,redirect_url,error,snapshot_path\n";
  const rows = results.map((r, i) => {
    const esc = (s) => `"${String(s || "").replace(/"/g, '""')}"`;
    return [
      i + 1,
      esc(r.url),
      r.status || "",
      esc(r.title),
      esc(r.h1),
      r.linksFound,
      r.loadMs,
      esc(r.redirectUrl),
      esc(r.error),
      esc(r.snapshotPath),
    ].join(",");
  });
  fs.writeFileSync(filepath, header + rows.join("\n"), "utf8");
  console.log(`  ${c.green}✓ CSV saved to: ${filepath}${c.reset}\n`);
}

// ─────────────────────────────────────────────
//  Core crawl logic
// ─────────────────────────────────────────────
async function crawlPage(page, pageUrl, opts) {
  const result = {
    url: pageUrl,
    status: null,
    title: "",
    h1: "",
    linksFound: 0,
    loadMs: 0,
    redirectUrl: "",
    links: [],
  };

  const t0 = Date.now();
  let response = null;

  try {
    response = await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: opts.timeout,
    });

    result.status      = response?.status() ?? null;
    result.redirectUrl = response?.url() !== pageUrl ? (response?.url() ?? "") : "";
    result.loadMs      = Date.now() - t0;

    // Extract page metadata + links
    const data = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      return {
        title: document.title || "",
        h1:    document.querySelector("h1")?.innerText?.trim() || "",
        hrefs: anchors.map(a => a.getAttribute("href")).filter(Boolean),
      };
    });

    result.title      = data.title;
    result.h1         = data.h1;
    result.linksFound = data.hrefs.length;
    result.links      = data.hrefs;

  } catch (err) {
    result.loadMs = Date.now() - t0;
    result.error  = err.message;

    // Handle timeout snapshot if enabled
    if (opts.snapshotOnTimeout && err.message.toLowerCase().includes("timeout")) {
      try {
        const dir = path.join(process.cwd(), "timeouts");
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        const urlObj = new URL(pageUrl);
        const safePath = urlObj.pathname.replace(/[^a-z0-9]/gi, "_").slice(0, 50);
        const filename = `timeout_${Date.now()}_${urlObj.hostname}${safePath}`;

        const screenshotPath = path.join(dir, `${filename}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

        const htmlPath = path.join(dir, `${filename}.html`);
        const content = await page.content().catch(() => "");
        if (content) {
          fs.writeFileSync(htmlPath, content, "utf8");
        }

        result.snapshotPath = screenshotPath;
        result.htmlPath = htmlPath;
      } catch (snapErr) {
        // Fail silently to keep crawler stable
      }
    }
  }

  return result;
}

// ─────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  const startMs = Date.now();

  // If loginUrl is specified but no credentials are, we must show the browser window for manual login
  if (opts.loginUrl && (!opts.username || !opts.password)) {
    opts.headless = false;
  }

  printHeader(opts.startUrl);

  const browser = await chromium.launch({ headless: opts.headless });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (compatible; PlaywrightSEOSpider/1.0; +https://github.com/playwright)",
    ignoreHTTPSErrors: opts.ignoreHttpsErrors,
  });

  // ─────────────────────────────────────────────
  //  Optional Authentication / Login Step
  // ─────────────────────────────────────────────
  if (opts.loginUrl) {
    console.log(c.bold + c.yellow + `\n🔑 Initiating login session at: ${opts.loginUrl}` + c.reset);
    const loginPage = await context.newPage();
    try {
      await loginPage.goto(opts.loginUrl, { waitUntil: "networkidle", timeout: 30000 });

      if (opts.username && opts.password) {
        console.log(`🤖 Attempting automated login...`);
        const userSel = opts.userSelector || 'input[type="email"], input[type="text"], input[name="username"], input[name="login"]';
        const passSel = opts.passSelector || 'input[type="password"]';
        const submitSel = opts.submitSelector || 'button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in")';

        await loginPage.locator(userSel).first().fill(opts.username);
        await loginPage.locator(passSel).first().fill(opts.password);
        
        await Promise.all([
          loginPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}),
          loginPage.locator(submitSel).first().click()
        ]);
        console.log(`🤖 Automated login form submitted.`);
      }

      // If interactive verification is needed (no credentials provided, or explicitly running in non-headless)
      if (!opts.username || !opts.password || opts.headless === false) {
        console.log(c.cyan + `\n👉 Please complete/verify the login in the browser window.` + c.reset);
        console.log(c.bold + `👉 Press [Enter] in this terminal once you have successfully logged in...` + c.reset);
        
        // Wait for stdin keypress
        await new Promise(resolve => {
          process.stdin.once('data', () => {
            resolve();
          });
        });
      } else {
        // Wait for a few seconds to let any redirects settle
        await loginPage.waitForTimeout(5000);
      }
      
      console.log(c.green + `✓ Login session active. Starting crawler...\n` + c.reset);
    } catch (err) {
      console.error(c.red + `⚠️ Login failed: ${err.message}` + c.reset);

      if (opts.snapshotOnTimeout) {
        try {
          const dir = path.join(process.cwd(), "timeouts");
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          const filename = `login_failure_${Date.now()}`;
          const screenshotPath = path.join(dir, `${filename}.png`);
          await loginPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

          const htmlPath = path.join(dir, `${filename}.html`);
          const content = await loginPage.content().catch(() => "");
          if (content) {
            fs.writeFileSync(htmlPath, content, "utf8");
          }
          console.log(c.yellow + `📸 Saved login failure snapshots to:\n   - ${screenshotPath}\n   - ${htmlPath}` + c.reset);
        } catch (snapErr) {
          // Fail silently
        }
      }

      console.error(c.red + `\nFatal: Crawl aborted because login failed. Please verify your login credentials, selectors, or network connection.\n` + c.reset);
      await loginPage.close().catch(() => {});
      await browser.close().catch(() => {});
      process.exit(1);
    } finally {
      await loginPage.close().catch(() => {});
    }
  }

  // Intercept & abort images, fonts, media to speed up crawl (configured after login so login page style is intact)
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "font", "media", "stylesheet"].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  const visited    = new Set();
  const queue      = [opts.startUrl];
  const results    = [];
  let   errorCount = 0;

  visited.add(opts.startUrl);
  printTableHeader();

  // Worker pool
  async function worker() {
    while (queue.length > 0 && results.length < opts.maxPages) {
      const pageUrl = queue.shift();
      if (!pageUrl) break;

      const page   = await context.newPage();
      const result = await crawlPage(page, pageUrl, opts);
      await page.close();

      results.push(result);
      if (!result.status) errorCount++;

      printRow(results.length, result);

      // Enqueue discovered links
      for (const href of result.links) {
        const abs = normalise(href, pageUrl);
        if (!abs) continue;
        if (visited.has(abs)) continue;
        if (opts.sameDomain && !sameDomain(abs, opts.startUrl)) continue;
        if (opts.samePath && !samePath(abs, opts.startUrl)) continue;
        if (!isHtmlUrl(abs, opts.includeExt)) continue;
        visited.add(abs);
        queue.push(abs);
      }
    }
  }

  // Show live progress line while workers run
  const progressInterval = setInterval(() => {
    printProgress(results.length, queue.length, errorCount);
  }, 400);

  // Run concurrency workers
  const workers = Array.from({ length: opts.concurrency }, () => worker());
  await Promise.all(workers);

  clearInterval(progressInterval);
  process.stdout.write("\n");

  await browser.close();

  printSummary(results, startMs);

  // Optional CSV export
  if (opts.output) {
    writeCsv(opts.output, results);
  } else {
    // Auto-save to timestamped file
    const ts  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const out = `crawl-report-${ts}.csv`;
    writeCsv(out, results);
  }
}

main().catch((err) => {
  console.error(c.red + "\nFatal error: " + err.message + c.reset);
  process.exit(1);
});
