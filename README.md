# Closet Scraper (Crawlee + Playwright)

Google Maps lead extraction and enrichment worker for DitchTheForm outbound.

## What this worker does

1. Generates Google Maps search URLs from keyword/location combinations.
2. Opens each query in a PlaywrightCrawler and scrolls Maps results (detecting and retrying through Google CAPTCHA / "unusual traffic" walls).
3. Visits each business place URL and extracts lead fields:
	- Business name
	- Primary and additional business categories
	- Listed services (with category/search-keyword fallback provenance)
	- Website URL
	- Social profile URL (kept separate from an owned website)
	- Phone number
	- Address
	- Rating text
4. Runs deep-site email discovery on contractor domains (homepage + top contact/about/team links + second-pass internal pages).
5. Extracts likely decision-makers (owner/founder/president/principal/CEO/managing partner) from team/about pages and JSON-LD Person data.
6. Infers personal-email patterns per domain and generates personal candidate emails.
7. Optionally validates candidates with MX and SMTP probes (strictly gated by env flags).
8. Enriches each lead by checking for contact-form signals on the business site.
9. Classifies leads into two outbound pipelines based on whether the business has a reachable website:
	- **PIPELINE_A** (widget cold outreach): the business has a working website (at least one page fetched), whether or not a contact form was detected (`contact_form_detected` / `no_contact_form_detected`).
	- **PIPELINE_B** (website agency upsell): the business has no website (`missing_website`) or its site could not be fetched (`contact_page_fetch_failed`).
10. Exports each run to local JSON/CSV for QA before outreach.
11. Sends batched JSON payloads to Instantly webhook endpoints.

## Environment setup

Copy `.env.example` to `.env`, then configure:

- `PROXY_URLS`: comma-separated rotating proxies.
- `PROXY_GATEWAY_URL`: optional stable gateway URL (recommended with recurring IP replacement plans).
- `START_URLS`: optional direct Google Maps search URLs for one-off testing.
- `DISABLE_WEBHOOKS`: set `true` to skip Instantly delivery and test scraping only.
- `MAPS_KEYWORDS`: comma-separated vertical terms.
- `TARGET_LOCATIONS`: comma-separated cities, states, ZIP codes, or areas.
- `NO_WEBSITE_ONLY`, `PHONE_REQUIRED`, `REQUIRE_CATEGORY_MATCH`
- `MIN_RATING`, `MIN_REVIEW_COUNT`, `SEARCH_RADIUS_MILES`
- `INSTANTLY_PIPELINE_A_WEBHOOK_URL`
- `INSTANTLY_PIPELINE_B_WEBHOOK_URL`

## Production operations

- Set `MAX_CONCURRENCY` to **1–2** on Apify/production runs to reduce Maps CAPTCHA rate and proxy burn.
- When `DISABLE_WEBHOOKS=false`, **`WEBHOOK_AUTH_TOKEN` must match** `INSTANTLY_RECEIVER_AUTH_TOKEN` on the dashboard. The scraper refuses to POST batches if the URL is set but the token is empty.
- Failed webhook batches are logged with status and response body (first 500 chars) per batch.

Optional:

- `WEBHOOK_AUTH_HEADER` and `WEBHOOK_AUTH_TOKEN`
- `PROXY_HEALTHCHECK_ENABLED`, `PROXY_HEALTHCHECK_TIMEOUT_MS`, `PROXY_HEALTHCHECK_MIN_HEALTHY`
- `PROXY_HEALTHCHECK_HTTP` (default `true`): also issue an HTTP request *through* each proxy (not just a TCP connect) to confirm it can relay traffic.
- `PROXY_HEALTHCHECK_URL` (default `http://www.google.com/generate_204`): target for the HTTP-through-proxy check.
- `MAX_RESULTS_PER_QUERY`, `MAX_CONCURRENCY`, `MAX_REQUESTS_PER_CRAWL`
- `MAX_REQUEST_RETRIES` (default `3`): retry transient failures (timeouts, proxy errors, CAPTCHA blocks) with a fresh session before giving up.
- `SCRAPER_MERGE_EXPORTS` (default `false`): after a run, merge every `exports/run-*` dataset from a per-city loop into one deduped `exports/combined` dataset.
- `EMAIL_DISCOVERY_MAX_PAGES`, `EMAIL_DISCOVERY_SECOND_PASS_PAGES`, `EMAIL_DISCOVERY_TIMEOUT_MS`
- `DECISION_MAKER_MAX_PAGES`, `EMAIL_CONFIDENCE_THRESHOLD`
- `ENABLE_MX_CHECK`, `ENABLE_SMTP_CHECK`, `SMTP_TIMEOUT_MS`, `SMTP_MIN_INTERVAL_MS`, `SMTP_MAX_PROBES_PER_DOMAIN`
- `DOMAIN_CACHE_ENABLED`, `DOMAIN_CACHE_FILE`
- `DOMAIN_CACHE_PATTERN_TTL_DAYS`, `DOMAIN_CACHE_VALIDATION_TTL_DAYS`
- `SCRAPER_CONTROL_PLANE_CONFIG_URL`, `SCRAPER_CONTROL_PLANE_TOKEN`
- `SCRAPER_CONTROL_PLANE_TIMEOUT_MS`
- `SCRAPER_RUN_STATUS_URL`, `SCRAPER_RUN_STATUS_TOKEN`

Webhook automation to Instantly:

- Set both `INSTANTLY_PIPELINE_A_WEBHOOK_URL` and `INSTANTLY_PIPELINE_B_WEBHOOK_URL`
	to your dashboard receiver endpoint: `/api/instantly/scraper-webhook`.
- Set `WEBHOOK_AUTH_TOKEN` to the same value as dashboard
	`INSTANTLY_RECEIVER_AUTH_TOKEN`.
- Each webhook batch now includes:
	- campaign blueprint metadata
	- sequence timing metadata
	- run id and idempotency key

Remote control-plane (optional):

- When `SCRAPER_CONTROL_PLANE_CONFIG_URL` + `SCRAPER_CONTROL_PLANE_TOKEN` are set,
	the scraper fetches runtime config from dashboard (`/api/scraper/config`) at
	startup and merges it over local env defaults.
- Proxy behavior supports both:
	- stable `proxyGatewayUrl` (preferred)
	- fallback `proxyUrls` list
	If gateway is set, it takes precedence over the list.
- This allows admin-managed config updates without rebuilding/redeploying the
	scraper workload.
- If `SCRAPER_RUN_STATUS_URL` is set, scraper posts `started`, `completed`, and
	`failed` lifecycle events to dashboard (`/api/scraper/run-status`) for monitoring.
- Prefer your production custom domain for these URLs (for example,
	`https://www.ditchtheform.com`) rather than `*.vercel.app`.
- If your production domain is protected by Vercel Deployment Protection,
	set `SCRAPER_VERCEL_BYPASS_SECRET` and scraper will send the
	`x-vercel-protection-bypass` header automatically.

Persistent memory (Hunter-like network effect):

- The scraper stores inferred domain email patterns and MX/catch-all results in `DOMAIN_CACHE_FILE`.
- This cache is reused across runs so repeated domains get smarter candidate generation and fewer repeated probes.
- Pattern intelligence and validation intelligence have separate TTL windows so MX/catch-all can refresh more often than naming patterns.
- Keep the cache enabled for production loops; disable only for clean-room testing.

## Commands

- `npm run start:dev`
- `npm run start:full-headless`
- `npm run start:full-headless:no-webhooks`
- `npm run start:loop-cities`
- `npm run start:one-city`
- `npm run start:test-no-webhooks`
- `npm run start:clarksville`
- `npm run start:clarksville:headless`
- `npm run build`
- `npm run start:prod`

## Running The Whole City List

Important: if `START_URLS` is set in `.env`, it overrides `TARGET_LOCATIONS`.
To run the full `TARGET_LOCATIONS` list, use:

- `npm run start:full-headless:no-webhooks`

This command clears `START_URLS` for the run and keeps the scraper in headless mode.

## City-By-City Loop Runner

Use this for safer pacing against Google:

- `npm run start:loop-cities`

Optional loop controls:

- `LOOP_KEYWORD` (default: `custom closet contractors`)
- `LOOP_START_INDEX` (default: `0`)
- `LOOP_LIMIT` (default: all remaining cities)
- `LOOP_SLEEP_MIN` / `LOOP_SLEEP_MAX` in seconds (defaults: `8` / `20`)
- `LOOP_RESUME` (default: `true`)
- `LOOP_RESET_CHECKPOINT=true` (start this run from scratch)
- `LOOP_CHECKPOINT_FILE` (default: `storage/loop-checkpoint.json`)

Example:

- `LOOP_LIMIT=10 LOOP_SLEEP_MIN=15 LOOP_SLEEP_MAX=30 npm run start:loop-cities`
- `LOOP_RESET_CHECKPOINT=true LOOP_LIMIT=10 npm run start:loop-cities`

## Google Risk Management

To reduce blocks / captchas:

- Keep `MAX_CONCURRENCY` low (recommend `1-2` for broad city runs)
- Keep per-query load moderate (`MAX_RESULTS_PER_QUERY` around `20-50`)
- Add jitter between city runs (loop script already does this)
- Keep rotating proxies healthy and remove consistently failing endpoints
- Enable startup proxy health checks to drop dead endpoints before crawl begins
- Prefer many small batches over one huge burst

## Output

- Crawlee stores each qualified lead in the default dataset.
- Each run writes files in `exports/run-<timestamp>/` with `leads.json`, `leads.csv`, `summary.json`, plus Instantly-ready CSVs.
- When `SCRAPER_MERGE_EXPORTS=true`, a per-city loop's runs are aggregated (deduped by email → website domain → Maps place URL) into `exports/combined/leads.json` and `exports/combined/leads.csv`.
- Instantly CSV files:
	- `instantly_all.csv`
	- `instantly_pipeline_a.csv`
	- `instantly_pipeline_b.csv`
	- `instantly_suppressed.csv`
	- `instantly_pipeline_a_upload.csv` (lean upload format)
	- `instantly_pipeline_b_upload.csv` (lean upload format)
- Each run also generates `instantly_campaign_playbook.md` with:
	- campaign names
	- cold sequence copy for Pipeline A / B
	- follow-up timing (A: 3 days, B: 4 days)
	- positive-reply follow-up templates
	- safety-control checklist (daily cap, delay, sending window)
- Instantly headers follow campaign-tag format: `email`, `firstName`, `lastName`, `companyName`, `website`, `phone`, `city`, `rating`, `reviewCount`.
- Lean upload CSV headers are exactly: `Email`, `First Name`, `Company Name`, `Website`.
- Instantly rows also include `decisionMakerName`, `decisionMakerTitle`, `decisionMakerEmail`, `emailType`, `emailConfidence`, `emailSource`, `unsubscribeToken`, and `unsubscribeUrl` fields.
- Suppression and role filtering can be configured via `.env` (`SUPPRESSION_*`, `EXCLUDE_ROLE_EMAILS`, `ROLE_LOCAL_PARTS`).
- CSV includes discovered emails, decision-maker fields, confidence score/label, and outreach rank (`A1`, `A2`, `B1`, `B2`) for QA triage.
- Worker logs summary stats and webhook dispatch outcomes at run completion.

## Deploy To Apify

This scraper is a batch-style worker built with Crawlee, so it deploys natively to the Apify platform.

### Automated production deployment

Every pull request to `master` runs the **Test scraper** check. Every push to
`master` runs that same check and, after it passes, runs **Deploy scraper to
Apify**. GitHub Actions installs dependencies, runs the full test suite,
compiles the scraper, and only then deploys the Actor with the `latest` build
tag. The deployment check fails if the Apify build does not finish
successfully, so it is the production deployment status for that commit.

The repository must have an Actions secret named `APIFY_TOKEN`. Create the token
in Apify Console under **Settings -> Integrations**, then add it in GitHub under
**Settings -> Secrets and variables -> Actions -> Repository secrets**. The
workflow can also be rerun manually from GitHub's **Actions** tab.

Protect `master` with the **Test scraper** status check if pull requests are
used. Do not manually retag a failed build as `latest`.

### Manual fallback
Use the Apify CLI to push this repo as an Actor:
`npx apify-cli push`

### Configure Actor environment variables
In the Apify Console, navigate to your new Actor -> **Source** tab -> **Environment Variables**.
Set the following:
- `SCRAPER_CONTROL_PLANE_CONFIG_URL`
- `SCRAPER_CONTROL_PLANE_TOKEN`
- `SCRAPER_RUN_STATUS_URL`
- `SCRAPER_RUN_STATUS_TOKEN`
- `WEBHOOK_AUTH_TOKEN`

### Trigger from Dashboard
Update your Closet Dashboard's Vercel environment variables with `SCRAPER_TRIGGER_WEBHOOK_URL` pointing to the Apify Actor Run API endpoint. Your dashboard will now automatically configure and launch the Apify scraper on demand.
