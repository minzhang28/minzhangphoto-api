
// Optimized Cloudflare Worker with R2 Image Caching

export default {
  async fetch(request, env) {
    // CORS handling
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);

    try {
      // Routes
      if (url.pathname === "/api/collections") {
        return await handleCollections(env);
      } else if (url.pathname.startsWith("/api/collection/")) {
        const collectionId = url.pathname.split("/").pop();
        return await handleCollectionDetail(collectionId, env);
      } else if (url.pathname.startsWith("/images/")) {
        // Serve images directly from R2
        return await handleImageRequest(url.pathname, env);
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  },
};

// Handle image requests from R2
async function handleImageRequest(pathname, env) {
  const key = pathname.substring(1); // Remove leading /
  
  try {
    const object = await env.PHOTO_BUCKET.get(key);
    
    if (!object) {
      return new Response("Image not found", { status: 404 });
    }

    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("R2 error:", error);
    return new Response("Error fetching image", { status: 500 });
  }
}

// Get all collections (optimized)
async function handleCollections(env) {
  const CACHE_KEY = "collections:all:v2";
  const CACHE_TTL = 300; // 5 minutes

  // Check KV cache
  const cached = await env.CACHE_KV?.get(CACHE_KEY, "json");
  if (cached) {
    console.log("Cache hit for collections");
    return jsonResponse(cached, { "X-Cache": "HIT" });
  }

  console.log("Cache miss, fetching from Notion...");

  // Query Notion database
  const response = await notionQuery(env.NOTION_DATABASE_ID, env.NOTION_API_KEY);

  // Process images in parallel to R2
  const collections = await Promise.all(
    response.results.map(async (result) => {
      const properties = result.properties;
      
      // Extract images from Database Property (not page content)
      const images = extractImagesFromProperty(properties);
      
      console.log(`[${result.id}] Found ${images.length} images`);

      // Cache all images to R2 in parallel
      const cachedImageUrls = await Promise.all(
        images.slice(0, 4).map((imgUrl, i) => 
          cacheImageToR2(imgUrl, `${result.id}-${i}`, env)
        )
      );

      const validImages = cachedImageUrls.filter(Boolean);

      return {
        id: result.id,
        title: properties.Name?.title?.[0]?.plain_text || "Untitled",
        subtitle: properties.Subtitle?.rich_text?.[0]?.plain_text || "",
        location: properties.Location?.rich_text?.[0]?.plain_text || "",
        year: properties.Year?.number || new Date().getFullYear(),
        description: properties.Description?.rich_text?.[0]?.plain_text || "",
        count: images.length,
        cover: validImages[0] || "",
        previewImages: validImages.slice(0, 3),
      };
    })
  );

  const validCollections = collections.filter(Boolean);

  // Store in KV cache
  if (env.CACHE_KV) {
    await env.CACHE_KV.put(CACHE_KEY, JSON.stringify(validCollections), {
      expirationTtl: CACHE_TTL,
    });
  }

  return jsonResponse(validCollections, { 
    "X-Cache": "MISS",
    "Cache-Control": `public, max-age=${CACHE_TTL}`,
  });
}

// Get single collection detail
async function handleCollectionDetail(collectionId, env) {
  const CACHE_KEY = `collection:${collectionId}:v2`;
  const CACHE_TTL = 600; // 10 minutes

  // Check cache
  const cached = await env.CACHE_KV?.get(CACHE_KEY, "json");
  if (cached) {
    console.log(`Cache hit for collection ${collectionId}`);
    return jsonResponse(cached, { "X-Cache": "HIT" });
  }

  console.log(`Cache miss for collection ${collectionId}`);

  // Get Notion page
  const [pageInfo, pageDetails] = await Promise.all([
    getPageInfo(collectionId, env.NOTION_API_KEY),
    getPageDetails(collectionId, env.NOTION_API_KEY),
  ]);

  const properties = pageInfo.properties;
  
  // Extract images from Database Property
  const allImageUrls = extractImagesFromProperty(properties);

  // Cache all images to R2 in parallel
  const cachedImages = await Promise.all(
    allImageUrls.map((imgUrl, i) => 
      cacheImageToR2(imgUrl, `${collectionId}-${i}`, env)
        .then(url => ({
          url,
          title: `Image ${i + 1}`,
          description: "",
        }))
    )
  );

  const collection = {
    id: collectionId,
    title: properties.Name?.title?.[0]?.plain_text || "Untitled",
    subtitle: properties.Subtitle?.rich_text?.[0]?.plain_text || "",
    location: properties.Location?.rich_text?.[0]?.plain_text || "",
    year: properties.Year?.number || new Date().getFullYear(),
    description: properties.Description?.rich_text?.[0]?.plain_text || "",
    count: cachedImages.length,
    cover: cachedImages[0]?.url || "",
    images: cachedImages,
  };

  // Store in cache
  if (env.CACHE_KV) {
    await env.CACHE_KV.put(CACHE_KEY, JSON.stringify(collection), {
      expirationTtl: CACHE_TTL,
    });
  }

  return jsonResponse(collection, { 
    "X-Cache": "MISS",
    "Cache-Control": `public, max-age=${CACHE_TTL}`,
  });
}

// Core function: Cache image to R2
async function cacheImageToR2(notionUrl, blockId, env) {
  if (!notionUrl || !env.PHOTO_BUCKET) {
    console.warn("Missing URL or R2 bucket");
    return notionUrl;
  }

  const r2Key = `images/${blockId}.jpg`;
  
  try {
    // Check if image exists in R2
    const existing = await env.PHOTO_BUCKET.head(r2Key);
    if (existing) {
      console.log(`Image exists in R2: ${r2Key}`);
      return `${env.PUBLIC_URL || ""}/images/${blockId}.jpg`;
    }

    console.log(`Downloading image to R2: ${r2Key}`);

    // Download Notion image
    const response = await fetch(notionUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Cloudflare Worker)",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }

    // Upload to R2
    await env.PHOTO_BUCKET.put(r2Key, response.body, {
      httpMetadata: {
        contentType: response.headers.get("Content-Type") || "image/jpeg",
      },
    });

    console.log(`Image cached to R2: ${r2Key}`);
    return `${env.PUBLIC_URL || ""}/images/${blockId}.jpg`;

  } catch (error) {
    console.error(`Failed to cache image to R2: ${r2Key}`, error);
    // Fallback: return original URL
    return notionUrl;
  }
}

// Notion API wrappers
async function notionQuery(databaseId, token) {
  const response = await fetch(
    `https://api.notion.com/v1/databases/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page_size: 100,
        // No filter_properties - get all properties including Files
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Notion API error:", response.status, errorText);
    throw new Error(`Notion API error: ${response.status}`);
  }

  const data = await response.json();
  
  // Debug: log first result's properties
  if (data.results?.[0]) {
    console.log("[DEBUG] First result property keys:", Object.keys(data.results[0].properties));
    const imagesProp = data.results[0].properties.Images || data.results[0].properties.images;
    console.log("[DEBUG] Images property type:", imagesProp?.type);
    console.log("[DEBUG] Images has files:", !!imagesProp?.files);
  }
  
  return data;
}

async function getPageInfo(pageId, token) {
  const response = await fetch(
    `https://api.notion.com/v1/pages/${pageId}`,
    {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch page info: ${response.status}`);
  }

  return await response.json();
}

async function getPageDetails(pageId, token) {
  const response = await fetch(
    `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
    {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch page details: ${response.status}`);
  }

  return await response.json();
}

// Helper functions
function extractImagesFromProperty(properties) {
  console.log("[DEBUG] Property keys:", Object.keys(properties));
  
  // Try multiple possible field names (case-insensitive)
  const imageProp = properties.Images || properties.images || 
                    properties.Image || properties.image;
  
  console.log("[DEBUG] Image property found:", !!imageProp);
  console.log("[DEBUG] Has files:", !!imageProp?.files);
  
  if (!imageProp || !imageProp.files) {
    console.warn("[DEBUG] No image property or files found");
    return [];
  }
  
  console.log("[DEBUG] Number of files:", imageProp.files.length);
  
  const urls = imageProp.files
    .map(item => {
      if (item.type === "file") {
        return item.file?.url || "";
      } else if (item.type === "external") {
        return item.external?.url || "";
      }
      return "";
    })
    .filter(Boolean);
  
  console.log("[DEBUG] Extracted URLs count:", urls.length);
  return urls;
}

function extractImages(pageDetails) {
  if (!pageDetails?.results) return [];
  
  return pageDetails.results
    .filter(block => block.type === "image")
    .map(block => {
      // Support both file and external image types
      const imageData = block.image;
      let url = "";
      
      if (imageData?.file?.url) {
        url = imageData.file.url;
      } else if (imageData?.external?.url) {
        url = imageData.external.url;
      }
      
      return {
        url: url,
        caption: imageData?.caption?.[0]?.plain_text || "",
      };
    })
    .filter(img => img.url);
}

function jsonResponse(data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

