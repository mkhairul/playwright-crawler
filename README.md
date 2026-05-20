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

---

## Options

| Flag               | Default | Description                                         |
|--------------------|---------|-----------------------------------------------------|
| `--max-pages <n>`  | `200`   | Stop after crawling n pages                         |
| `--concurrency <n>`| `3`     | Number of parallel browser tabs                     |
| `--same-domain`    | `true`  | Only follow links on the same domain                |
| `--no-same-domain` | —       | Follow all links regardless of domain               |
| `--same-path`      | `false` | Only follow links under starting URL's path/region  |
| `--include-ext`    | —       | Extra file extensions to crawl (e.g. `.php,.asp`)   |
| `--output <file>`  | auto    | Write CSV report to this filename                   |
| `--timeout <ms>`   | `15000` | Navigation timeout per page (milliseconds)          |
| `--no-headless`    | —       | Show the browser window while crawling              |

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
