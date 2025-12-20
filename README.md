# Notion Portfolio API Worker

A high-performance Cloudflare Worker acting as a middleware between the Notion API and the frontend. It handles data ETL, solves S3 link expiration issues, and implements aggressive edge caching.

## 🚀 Features

* **Notion Proxy:** Fetches and filters data from a Notion Database, returning a clean, frontend-ready JSON.
* **Smart Image Caching:** Proxies signed S3 URLs from Notion. Uses `blockId` as a stable cache key to ignore expiring signatures, enabling **permanent edge caching** for images.
* **CORS Handling:** Global CORS support for seamless frontend integration.
* **Performance:**
    * JSON Data: Cached for 60 seconds (Stale-while-revalidate logic).
    * Images: Cached for 1 year (Immutable).

## 🛠 Configuration

Set the following secrets in your Cloudflare Dashboard or `.dev.vars` file:

| Variable | Description |
| :--- | :--- |
| `NOTION_API_KEY` | Your Notion Integration Internal Secret (`secret_...`) |
| `NOTION_DATABASE_ID` | The ID of the database containing the portfolio items |

## 🔌 API Endpoints

### 1. Get Portfolio Data
Returns the transformed list of projects.

```http
GET /
