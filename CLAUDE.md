# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A single-file Cloudflare Worker (`worker.js`) that acts as a REST API for a photography portfolio. It bridges a Notion database (used as the CMS) with a frontend, solving Notion's expiring S3 image URL problem by permanently caching images in Cloudflare R2.

## Development Commands

```bash
# Create local secrets file (do not commit)
echo "NOTION_API_KEY=your_key_here" > .dev.vars
echo "NOTION_DATABASE_ID=your_db_id_here" >> .dev.vars

# Run locally
wrangler dev

# Deploy to production
wrangler deploy

# Set/update production secrets
wrangler secret put NOTION_API_KEY
wrangler secret put NOTION_DATABASE_ID
```

There is no build step, no test suite, and no package.json — `wrangler` is the only toolchain needed (install via `npm install -g wrangler`).

## Architecture

All logic lives in `worker.js`. The entry point routes requests to three handlers:

- **`/api/collections`** → `handleCollections`: queries the Notion database, caches all images to R2 in parallel, stores the JSON response in KV (5-min TTL), returns the collection list.
- **`/api/collection/:id`** → `handleCollectionDetail`: fetches a single Notion page's properties, caches its images to R2 in parallel, stores JSON in KV (10-min TTL).
- **`/images/:fileId.jpg`** → `handleImageRequest`: serves images from R2, with optional on-demand resizing via Cloudflare's Image Resizing feature (`?width=` and `?quality=` params). Falls back to serving the original if resizing fails.

**`cacheImageToR2`** is the core utility: given a Notion S3 URL, it checks R2 for existence, downloads the image if absent, and stores it permanently. The stable R2 key is `images/{fileId}.jpg` where `fileId` is extracted by `extractFileId`.

**Bindings** (configured in `wrangler.toml`):
- `env.PHOTO_BUCKET` — R2 bucket (`minzhang-photos`)
- `env.CACHE_KV` — KV namespace for JSON response caching
- `env.NOTION_API_KEY` / `env.NOTION_DATABASE_ID` — secrets

## Critical Implementation Details

**R2 body cancellation (deadlock prevention):** When checking R2 for an existing image with `.get()`, if the object exists and you don't intend to use its body, you **must** call `await existing.body?.cancel()`. Skipping this causes a deadlock in the Worker runtime. See `cacheImageToR2` lines ~258–264.

**Stable file IDs:** Notion's S3 URLs contain a UUID in the second-to-last path segment (`/workspace-id/FILE-UUID/filename.jpg`). `extractFileId` pulls this UUID to generate a permanent R2 key that survives Notion URL rotation.

**KV cache key versioning:** Cache keys use a `:v2` suffix (e.g., `collections:all:v2`, `collection:{id}:v2`). Bump the version suffix to force cache invalidation across all edges after schema or data format changes.

**Image source:** Images come from the `Images` database property (a Files & Media field on the Notion database page), **not** from page block content. `extractImagesFromProperty` handles this. The legacy `extractImages` function (which reads image blocks from page children) is no longer used in the main flow.

**Notion property name flexibility:** `getSortOrder`, `getStory`, and `extractImagesFromProperty` all try multiple casing/naming variants of property names to tolerate minor schema differences.

## Notion Database Schema

The worker expects these properties on the Notion database:

| Property | Type | Notes |
|---|---|---|
| `Name` | Title | Collection name |
| `Subtitle` | Rich Text | |
| `Location` | Rich Text | |
| `Year` | Number | |
| `Description` | Rich Text | |
| `Story` | Rich Text | |
| `SortOrder` | Number | Lower = appears first |
| `Images` | Files & Media | Source images; must be database property, not page blocks |
