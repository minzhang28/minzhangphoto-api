# Photography Portfolio API

A high-performance Cloudflare Worker that powers a photography portfolio website by bridging Notion databases with a frontend application. This API handles image caching, data transformation, and provides optimized endpoints for photo collections.

## Overview

This API solves the challenge of using Notion as a CMS for a photography portfolio by:
- **Fetching photo collections** from a Notion database
- **Caching images** to Cloudflare R2 storage (solving Notion's expiring S3 URL problem)
- **Optimizing performance** with KV-based response caching
- **Providing clean REST endpoints** for frontend consumption

## Architecture

```
┌────────────────┐      ┌──────────────────┐      ┌─────────────┐
│ Notion Database│ ◄────┤ Cloudflare Worker│ ◄────┤   Frontend  │
│   (CMS Source) │      │    (This API)    │      │  Application│
└────────────────┘      └──────────────────┘      └─────────────┘
                               │      │
                        ┌──────┘      └──────┐
                        ▼                    ▼
                   ┌────────┐          ┌──────────┐
                   │ R2 Bucket│          │ KV Cache │
                   │ (Images) │          │  (JSON)  │
                   └────────┘          └──────────┘
```

**Flow:**
1. API fetches photo collection data from Notion database
2. Images are downloaded from Notion's temporary S3 URLs
3. Images are permanently cached in R2 with stable file IDs
4. Collection metadata is cached in KV storage
5. Frontend receives optimized, long-lived image URLs

## API Endpoints

### `GET /api/collections`

Returns a list of all photo collections.

**Response:**
```json
[
  {
    "id": "collection-uuid",
    "title": "Collection Name",
    "subtitle": "Brief description",
    "location": "Location",
    "year": 2024,
    "description": "Full description",
    "count": 24,
    "cover": "/images/file-id.jpg",
    "previewImages": [
      "/images/file-id-1.jpg",
      "/images/file-id-2.jpg",
      "/images/file-id-3.jpg"
    ]
  }
]
```

**Caching:** 5 minutes (KV cache)

### `GET /api/collection/{collectionId}`

Returns detailed information about a specific collection including all images.

**Response:**
```json
{
  "id": "collection-uuid",
  "title": "Collection Name",
  "subtitle": "Brief description",
  "location": "Location",
  "year": 2024,
  "description": "Full description",
  "count": 24,
  "cover": "/images/file-id.jpg",
  "images": [
    {
      "url": "/images/file-id.jpg",
      "title": "Image",
      "description": ""
    }
  ]
}
```

**Caching:** 10 minutes (KV cache)

### `GET /images/{fileId}.jpg`

Serves images directly from R2 storage.

**Headers:**
- `Cache-Control: public, max-age=31536000, immutable`
- `Content-Type: image/jpeg` (or detected type)

**Caching:** 1 year (immutable)

## Features

### Image Caching & Stability
- Notion's image URLs expire after a few hours
- This API downloads images once and stores them in R2 with permanent URLs
- Uses stable file IDs extracted from Notion S3 URLs
- Prevents duplicate downloads with existence checks

### Performance Optimizations
- **Parallel image processing:** All images in a collection are cached concurrently
- **KV caching:** API responses cached to reduce Notion API calls
- **Deadlock prevention:** Proper cleanup of response streams
- **Retry logic:** Automatic retries for failed image downloads
- **Edge caching:** Global CDN distribution

### CORS Support
- Full CORS headers for cross-origin requests
- Supports OPTIONS preflight requests

## Setup

### Prerequisites
- Cloudflare account with Workers enabled
- Cloudflare R2 bucket
- Cloudflare KV namespace
- Notion integration and database

### Environment Variables

Configure these secrets in your Cloudflare Workers settings (via dashboard or CLI):

| Variable | Description | Example |
|----------|-------------|---------|
| `NOTION_API_KEY` | Notion integration token | `secret_...` |
| `NOTION_DATABASE_ID` | Database ID containing collections | `abc123...` |

### Bindings

Configure in `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "PHOTO_BUCKET"
bucket_name = "your-bucket-name"

[[kv_namespaces]]
binding = "CACHE_KV"
id = "your-kv-namespace-id"
```

### Notion Database Schema

Your Notion database should have these properties:

| Property Name | Type | Description |
|---------------|------|-------------|
| `Name` | Title | Collection name |
| `Subtitle` | Rich Text | Short description |
| `Location` | Rich Text | Location where photos were taken |
| `Year` | Number | Year of the collection |
| `Description` | Rich Text | Full description |
| `Images` | Files & Media | Photo files for the collection |

## Deployment

```bash
# Install dependencies
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Set secrets
wrangler secret put NOTION_API_KEY
wrangler secret put NOTION_DATABASE_ID

# Deploy
wrangler deploy
```

## Local Development

```bash
# Create .dev.vars file with your secrets
echo "NOTION_API_KEY=your_key_here" > .dev.vars
echo "NOTION_DATABASE_ID=your_db_id_here" >> .dev.vars

# Run locally
wrangler dev
```

## Technical Details

### Image ID Extraction
The API extracts stable file IDs from Notion's S3 URLs to ensure consistency:
- Notion format: `https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace-id/FILE-ID/filename.jpg?signature...`
- Extracted ID: `FILE-ID` (UUID)
- Fallback: Hash of the base URL

### Cache Strategy
- **Collections list:** 5-minute TTL, reduces Notion API load
- **Individual collections:** 10-minute TTL, allows for quick updates
- **Images:** Immutable, cached forever (content-addressed)

### Error Handling
- Graceful fallbacks to original Notion URLs if R2 caching fails
- Retry logic with exponential backoff for network failures
- Comprehensive error logging for debugging

## License

This is a personal project for a photography portfolio.
