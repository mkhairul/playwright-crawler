# 🕷 Playwright SEO Spider

A Screaming Frog-style web crawler built with [Playwright](https://playwright.dev/).  
Crawls a website, follows internal links, and reports status codes, titles, H1s, and link counts — similar to Screaming Frog SEO Spider.

---

## Installation

### Standard Installation
```bash
npm install
npx playwright install chromium
```

### DDEV Installation
If you are developing inside a [DDEV](https://ddev.com/) project, the DDEV web container handles Node.js and browser dependencies automatically.

1. Ensure your DDEV project is running:
   ```bash
   ddev start
   ```
2. Install dependencies inside the container:
   ```bash
   ddev exec npm install
   ```

---

## Usage

### Standard Usage
```bash
node crawler.js <url> [options]
```

### Examples
```bash
# Basic crawl (auto-saves CSV)
node crawler.js https://example.com

# Crawl only a specific path/region (e.g., en-ca)
node crawler.js https://example.com/en-ca/ --same-path

# Crawl up to 500 pages with 5 parallel tabs
node crawler.js https://example.com --max-pages 500 --concurrency 5

# Test pagination — crawl a paginated listing and count pages
node crawler.js "https://example.com/blog" --max-pages 1000

# Save CSV to a specific file
node crawler.js https://example.com --output report.csv

# Show the browser window while crawling
node crawler.js https://example.com --no-headless

# Allow external domains too
node crawler.js https://example.com --no-same-domain
```

### Running with DDEV
Run the crawler within your DDEV container using `ddev exec`:

```bash
# Basic crawl of your DDEV site
ddev exec node crawler.js https://playwright-crawler.ddev.site

# Crawl only a specific region under DDEV
ddev exec node crawler.js https://playwright-crawler.ddev.site/en-ca/ --same-path

# Crawl with specific options
ddev exec node crawler.js https://playwright-crawler.ddev.site --max-pages 500 --concurrency 5
```

### Crawling Lando / VIP Local Environments from DDEV

When crawling a site running in a **separate Docker environment** (e.g. Lando, VIP Dev Env) from inside your DDEV container, the containers are on **isolated Docker networks** by default and can't reach each other. The `*.lndo.site` hostname resolves to `127.0.0.1` inside DDEV, which is the DDEV container itself — not the Lando proxy.

The included **`connect-vip.sh`** script automates the networking setup:

1. Discovers the VIP dev-env proxy container and its IP
2. Connects the DDEV container to the VIP proxy's Docker network
3. Injects an `/etc/hosts` override so `*.lndo.site` hostnames resolve correctly

#### Commands

| Command | Description |
|---|---|
| `./connect-vip.sh connect [hostname]` | Set up the bridge (idempotent, safe to re-run) |
| `./connect-vip.sh disconnect` | Tear down the bridge cleanly |
| `./connect-vip.sh status [hostname\|url]` | Show connection state and test connectivity |
| `./connect-vip.sh crawl <url> [opts]` | Connect + run crawler in one step |

#### Examples

```bash
# One-liner: connect the bridge and crawl
./connect-vip.sh crawl "https://my-site.vipdev.lndo.site/en-ca/insights" --same-path --max-pages 100

# Or connect first, then crawl separately
./connect-vip.sh connect my-site.vipdev.lndo.site
ddev exec node crawler.js "https://my-site.vipdev.lndo.site/en-ca/insights" --same-path

# Check the bridge status (accepts a hostname or full URL)
./connect-vip.sh status my-site.vipdev.lndo.site

# Tear down when done
./connect-vip.sh disconnect
```

> [!NOTE]
> The `/etc/hosts` entry and Docker network connection are **ephemeral** — they reset on `ddev restart`. Just re-run `./connect-vip.sh connect` to restore them.

> [!IMPORTANT]
> Both environments must be running before connecting. Start your VIP/Lando environment first, then run `ddev start`, then `./connect-vip.sh connect`.

### Crawling VIP / Virtual-Host Local Environments

If your local environment uses **virtual hosting** (e.g. WordPress VIP, Lando, or any setup where the server expects a specific `Host` header), you'll get **404 errors** because the server doesn't know which site to serve.

Use `--host-header` to send the correct hostname:

```bash
# VIP local dev — server is on localhost:8080 but expects "mysite.com" as the Host
node crawler.js http://localhost:8080 --host-header "mysite.com"

# WordPress VIP with a custom domain mapping
node crawler.js http://localhost:8080/en-ca/ --host-header "mysite.com" --same-path

# If you need additional custom headers (e.g. auth tokens, X-Forwarded headers)
node crawler.js http://localhost:8080 --host-header "mysite.com" --extra-headers '{"X-Forwarded-Proto":"https"}'
```

> [!TIP]
> **How it works**: The `--host-header` flag sets the HTTP `Host` header on every request the crawler makes. This tells the local server which virtual host to serve, just like when you browse via a domain name. This is similar to adding an entry to your `/etc/hosts` file, but without modifying your system.

### Crawling Authenticated Sites (Login)

You can crawl pages behind a login screen using either **Interactive/Manual** login or **Automated** login. Because pages in the same session share cookies and local storage, once logged in, the entire crawler will access the protected pages.

#### 1. Interactive / Manual Login (Recommended for complex auth, SSO, MFA, or Captchas)
If you omit username/password, the crawler automatically opens a browser window and pauses to let you log in manually. Once completed, press **[Enter]** in the terminal to begin crawling:

```bash
node crawler.js https://example.com/protected --login-url https://example.com/login
```

#### 2. Automated Login (Standard Username/Password forms)
The crawler can automatically fill out username and password forms and submit them:

```bash
node crawler.js https://example.com/dashboard --login-url https://example.com/login --username "myuser" --password "mypassword"
```

If the login form uses custom CSS selectors, you can override them:
```bash
node crawler.js https://example.com/dashboard \
  --login-url https://example.com/login \
  --username "myuser" --password "mypassword" \
  --user-selector "#email-input" \
  --pass-selector "#password-input" \
  --submit-selector "button.submit-btn"
```

> [!IMPORTANT]
> **Login Failures**: If the login step fails (due to invalid credentials, selectors not found, or navigation timeouts), the crawler will automatically **abort** the crawl immediately to prevent running an unauthenticated scan.
> If `--snapshot-on-timeout` is enabled, it will save screenshot and HTML snapshots of the login page inside the `timeouts/` directory for visual troubleshooting.

---

## Options

| Flag                      | Default | Description                                         |
|---------------------------|---------|-----------------------------------------------------|
| `--max-pages <n>`         | `200`   | Stop after crawling n pages                         |
| `--concurrency <n>`       | `3`     | Number of parallel browser tabs                     |
| `--same-domain`           | `true`  | Only follow links on the same domain                |
| `--no-same-domain`        | —       | Follow all links regardless of domain               |
| `--same-path`             | `false` | Only follow links under starting URL's path/region  |
| `--include-ext`           | —       | Extra file extensions to crawl (e.g. `.php,.asp`)   |
| `--output <file>`         | auto    | Write CSV report to this filename                   |
| `--timeout <ms>`          | `15000` | Navigation timeout per page (milliseconds)          |
| `--no-headless`           | —       | Show the browser window while crawling              |
| `--ignore-https-errors`   | `true`  | Ignore SSL/HTTPS certificate errors                 |
| `--no-ignore-https-errors`| —       | Force SSL/HTTPS certificate validation              |
| `--snapshot-on-timeout`   | `false` | Take screenshot & HTML snapshot on timeouts          |
| `--host-header <host>`    | —       | Override Host header (for VIP/vhost local envs)      |
| `--extra-headers <json>`  | —       | Extra HTTP headers as JSON string                    |
| `--login-url <url>`       | —       | URL of the login page to authenticate first          |
| `--username <str>`        | —       | Username / Email for automated login                 |
| `--password <str>`        | —       | Password for automated login                         |
| `--user-selector <sel>`   | —       | Custom CSS selector for username input field         |
| `--pass-selector <sel>`   | —       | Custom CSS selector for password input field         |
| `--submit-selector <sel>` | —       | Custom CSS selector for the login submit button      |

---

## Output

### Terminal

Live table printed as pages are crawled:

```
  ╔══════════════════════════════════════════╗
  ║     🕷  Playwright SEO Spider Crawler     ║
  ╚══════════════════════════════════════════╝
  Target : https://example.com

  #    Status  Links  URL
  ────────────────────────────────────────────────────────────────────────────────
  1    200     42     https://example.com/
  2    200     18     https://example.com/about
  3    301     0      https://example.com/old-page
  ...

  ══════════════  CRAWL SUMMARY  ══════════════

  Total pages crawled :  47
  Total crawlable URLs:  47  (unique, same-domain)

  2xx OK          :  43
  3xx Redirects   :  2
  4xx Client Err  :  1
  5xx Server Err  :  0
  Network Errors  :  1

  Elapsed time    :  12.4s
```

### CSV Report

Auto-saved to `crawl-report-<timestamp>.csv` with these columns:

| Column         | Description                         |
|----------------|-------------------------------------|
| `index`        | Crawl order                         |
| `url`          | Page URL                            |
| `status`       | HTTP status code                    |
| `title`        | `<title>` tag content               |
| `h1`           | First `<h1>` tag content            |
| `links_found`  | Number of `<a href>` links on page  |
| `load_ms`      | Page load time (ms)                 |
| `redirect_url` | Final URL if redirect occurred      |
| `error`        | Error message if page crawl failed  |
| `snapshot_path`| Path to timeout snapshot if taken   |

---

## Pagination Testing

To count how many pages a paginated section has:

```bash
node crawler.js "https://example.com/products?page=1" --max-pages 9999
```

Look at the **Total pages crawled** number in the summary.  
The crawler follows `?page=2`, `?page=3` etc. automatically since it preserves query strings.

---

## How It Works

1. Starts at the given URL
2. Extracts all `<a href>` links from each page
3. Normalises and deduplicates URLs (strips `#` fragments, keeps query strings)
4. Filters to same-domain HTML pages only (skips images, PDFs, CSS, JS, etc.)
5. Queues new URLs and crawls them with a configurable worker pool
6. Intercepts and aborts images/fonts/media requests for speed
7. Prints live results and saves a CSV on completion

---

## Requirements

- Node.js 18+
- `npm install` to get Playwright
- `npx playwright install chromium` to get the browser binary
