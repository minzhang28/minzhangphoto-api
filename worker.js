/**
 * Cloudflare Worker: Notion API Proxy + S3 Image Caching Gateway
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Router Dispatch ---
    // 1. If path is /image, handle image proxy logic (Aggressive Caching)
    if (url.pathname === "/image") {
      return handleImageProxy(request, ctx);
    }

    // 2. Otherwise, default to Notion JSON logic (Short-term Caching)
    return handleJsonRequest(request, env, ctx);
  },
};

// ==========================================
// Logic A: Image Proxy (Proxy & Smart Cache)
// ==========================================
async function handleImageProxy(request, ctx) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url"); // The actual Notion S3 URL
  const blockId = url.searchParams.get("blockId"); // Stable identifier (Notion Block/Page UUID)

  // Validate parameters
  if (!targetUrl || !blockId) {
    return new Response("Missing 'url' or 'blockId' parameter", { status: 400 });
  }

  // 1. Check Cache (Cloudflare Edge Cache)
  const cache = caches.default;

  // [OPTIMIZATION]: Construct a stable Cache Key using blockId.
  // We ignore the 'targetUrl' for caching because it contains expiring signatures.
  // The cache key effectively becomes: https://api.domain.com/image/{UUID}
  const cacheKey = new Request(new URL(`https://${url.hostname}/image/${blockId}`), request);
  
  let response = await cache.match(cacheKey);

  if (response) {
    const newRes = new Response(response.body, response);
    newRes.headers.set("X-Image-Cache", "HIT");
    // Ensure CORS headers are present even on cache hit
    newRes.headers.set("Access-Control-Allow-Origin", "*");
    return newRes;
  }

  // 2. Cache Miss: Fetch from Origin (Notion/S3)
  const imageResponse = await fetch(targetUrl, {
    headers: {
      "User-Agent": "Cloudflare-Worker" // Polite behavior
    }
  });

  // If S3 link is expired or invalid, pass the error through
  if (!imageResponse.ok) {
    return imageResponse;
  }

  // 3. Header Cleaning & Reassembly
  const newHeaders = new Headers(imageResponse.headers);

  // Remove restrictive S3 headers
  newHeaders.delete("x-amz-request-id");
  newHeaders.delete("x-amz-id-2");
  newHeaders.delete("set-cookie"); 
  newHeaders.delete("expires");
  
  // Force Cache-Control
  // Browser: 1 year (immutable) - The browser will never ask again for this URL
  // Cloudflare Edge: 1 year (s-maxage)
  newHeaders.set("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
  newHeaders.set("CDN-Cache-Control", "max-age=31536000");
  newHeaders.set("X-Image-Cache", "MISS");
  newHeaders.set("Access-Control-Allow-Origin", "*"); // Enable CORS

  // 4. Rebuild Response and Write to Cache
  response = new Response(imageResponse.body, {
    status: imageResponse.status,
    statusText: imageResponse.statusText,
    headers: newHeaders,
  });

  // Write to cache using the STABLE cacheKey (based on blockId)
  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

// ==========================================
// Logic B: Notion JSON Data Aggregation
// ==========================================
async function handleJsonRequest(request, env, ctx) {
  const CACHE_TTL = 60; // Cache JSON for only 60 seconds to ensure freshness
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const cache = caches.default;
    const cacheUrl = new URL(request.url);
    const cacheKey = new Request(cacheUrl.toString(), request);

    // Check JSON Cache
    let response = await cache.match(cacheKey);
    if (response) {
      const newRes = new Response(response.body, response);
      newRes.headers.set("X-JSON-Cache", "HIT");
      return newRes;
    }

    if (!env.NOTION_API_KEY || !env.NOTION_DATABASE_ID) {
      throw new Error("Missing environment variables");
    }

    // Fetch from Notion API
    const notionUrl = `https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`;
    const notionResponse = await fetch(notionUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sorts: [{ property: "SortOrder", direction: "ascending" }],
      }),
    });

    if (!notionResponse.ok) {
      throw new Error(`Notion API Error: ${notionResponse.status}`);
    }

    const data = await notionResponse.json();
    const workerOrigin = new URL(request.url).origin; // e.g. https://api.minzhangphoto.com

    // --- ETL Data Transformation ---
    const cleanData = data.results.map((page, index) => {
      const props = page.properties;
      const pageId = page.id; // Stable UUID from Notion
      
      const getName = (p) => p?.title?.[0]?.plain_text || "Untitled";
      const getText = (p) => p?.rich_text?.[0]?.plain_text || "";

      // [Updated]: URL Rewrite Logic
      const getImages = (prop) => {
        if (!prop || !prop.files) return [];
        return prop.files.map((item) => {
          let rawUrl = null;
          if (item.type === 'file') rawUrl = item.file.url;
          else if (item.type === 'external') rawUrl = item.external.url;
          
          if (!rawUrl) return null;

          // *CORE CHANGE*: Wrap S3 URL into Worker Proxy URL with blockId
          // Result: https://api.../image?url=encodedUrl&blockId=UUID
          return `${workerOrigin}/image?url=${encodeURIComponent(rawUrl)}&blockId=${pageId}`;
        }).filter(Boolean);
      };

      const title = getName(props.name || props.Name);
      const location = getText(props.Location || props.location);
      const images = getImages(props.images || props.Images);
      const cover = images.length > 0 ? images[0] : "";

      return {
        id: pageId, // Use real UUID instead of index
        displayId: index + 1, // Keep an incremental ID for display if needed
        title,
        location,
        cover,
        images,
      };
    });

    // Create JSON Response
    response = new Response(JSON.stringify(cleanData, null, 2), {
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
        "Cache-Control": `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`,
        "X-JSON-Cache": "MISS",
      },
    });

    // Write JSON to Cache
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
}
