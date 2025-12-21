// ============================================
// 优化版 Cloudflare Worker - R2 图片缓存方案
// ============================================

export default {
async fetch(request, env) {
// CORS 处理
if (request.method === ‘OPTIONS’) {
return new Response(null, {
headers: {
‘Access-Control-Allow-Origin’: ‘*’,
‘Access-Control-Allow-Methods’: ‘GET, POST, OPTIONS’,
‘Access-Control-Allow-Headers’: ‘Content-Type’,
},
});
}

```
const url = new URL(request.url);

try {
  // 路由
  if (url.pathname === '/api/collections') {
    return await handleCollections(env);
  } else if (url.pathname.startsWith('/api/collection/')) {
    const collectionId = url.pathname.split('/').pop();
    return await handleCollectionDetail(collectionId, env);
  } else if (url.pathname.startsWith('/images/')) {
    // 直接从 R2 返回图片
    return await handleImageRequest(url.pathname, env);
  }

  return new Response('Not Found', { status: 404 });
} catch (error) {
  console.error('Error:', error);
  return new Response(JSON.stringify({ error: error.message }), {
    status: 500,
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
```

},
};

// ============================================
// 图片处理：从 R2 返回或代理
// ============================================

async function handleImageRequest(pathname, env) {
const key = pathname.substring(1); // 去掉开头的 /

try {
const object = await env.PHOTO_BUCKET.get(key);

```
if (!object) {
  return new Response('Image not found', { status: 404 });
}

return new Response(object.body, {
  headers: {
    'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
  },
});
```

} catch (error) {
console.error(‘R2 error:’, error);
return new Response(‘Error fetching image’, { status: 500 });
}
}

// ============================================
// 获取所有系列（优化版）
// ============================================

async function handleCollections(env) {
const CACHE_KEY = ‘collections:all:v2’;
const CACHE_TTL = 300; // 5分钟

// 1. 检查 KV 缓存
const cached = await env.CACHE_KV?.get(CACHE_KEY, ‘json’);
if (cached) {
console.log(‘✅ Cache hit for collections’);
return jsonResponse(cached, { ‘X-Cache’: ‘HIT’ });
}

console.log(‘⚠️ Cache miss, fetching from Notion…’);

// 2. 查询 Notion 数据库
const response = await notionQuery(env.NOTION_DATABASE_ID, env.NOTION_TOKEN);

// 3. 并行获取所有页面详情
const pageDetailsPromises = response.results.map(result =>
getPageDetails(result.id, env.NOTION_TOKEN).catch(err => {
console.error(`❌ Failed to get page ${result.id}:`, err);
return null;
})
);

const allPageDetails = await Promise.all(pageDetailsPromises);

// 4. 并行处理图片到 R2
const collections = await Promise.all(
response.results.map(async (result, index) => {
const pageDetails = allPageDetails[index];
if (!pageDetails) return null;

```
  const properties = result.properties;
  const images = extractImages(pageDetails);

  // 并行缓存所有图片到 R2
  const [coverUrl, ...imageUrls] = await Promise.all([
    cacheImageToR2(images[0]?.url, `${result.id}-cover`, env),
    ...images.slice(0, 3).map((img, i) => 
      cacheImageToR2(img.url, `${result.id}-preview-${i}`, env)
    )
  ]);

  return {
    id: result.id,
    title: properties.Name?.title?.[0]?.plain_text || 'Untitled',
    subtitle: properties.Subtitle?.rich_text?.[0]?.plain_text || '',
    location: properties.Location?.rich_text?.[0]?.plain_text || '',
    year: properties.Year?.number || new Date().getFullYear(),
    description: properties.Description?.rich_text?.[0]?.plain_text || '',
    count: images.length,
    cover: coverUrl,
    previewImages: imageUrls.filter(Boolean),
  };
})
```

);

const validCollections = collections.filter(Boolean);

// 5. 存入 KV 缓存
if (env.CACHE_KV) {
await env.CACHE_KV.put(CACHE_KEY, JSON.stringify(validCollections), {
expirationTtl: CACHE_TTL,
});
}

return jsonResponse(validCollections, {
‘X-Cache’: ‘MISS’,
‘Cache-Control’: `public, max-age=${CACHE_TTL}`,
});
}

// ============================================
// 获取单个系列详情
// ============================================

async function handleCollectionDetail(collectionId, env) {
const CACHE_KEY = `collection:${collectionId}:v2`;
const CACHE_TTL = 600; // 10分钟

// 检查缓存
const cached = await env.CACHE_KV?.get(CACHE_KEY, ‘json’);
if (cached) {
console.log(`✅ Cache hit for collection ${collectionId}`);
return jsonResponse(cached, { ‘X-Cache’: ‘HIT’ });
}

console.log(`⚠️ Cache miss for collection ${collectionId}`);

// 获取 Notion 页面
const [pageInfo, pageDetails] = await Promise.all([
getPageInfo(collectionId, env.NOTION_TOKEN),
getPageDetails(collectionId, env.NOTION_TOKEN),
]);

const properties = pageInfo.properties;
const allImages = extractImages(pageDetails);

// 并行缓存所有图片到 R2
const cachedImages = await Promise.all(
allImages.map((img, i) =>
cacheImageToR2(img.url, `${collectionId}-${i}`, env)
.then(url => ({
url,
title: img.caption || `图片 ${i + 1}`,
description: img.caption || ‘’,
}))
)
);

const collection = {
id: collectionId,
title: properties.Name?.title?.[0]?.plain_text || ‘Untitled’,
subtitle: properties.Subtitle?.rich_text?.[0]?.plain_text || ‘’,
location: properties.Location?.rich_text?.[0]?.plain_text || ‘’,
year: properties.Year?.number || new Date().getFullYear(),
description: properties.Description?.rich_text?.[0]?.plain_text || ‘’,
count: cachedImages.length,
cover: cachedImages[0]?.url || ‘’,
images: cachedImages,
};

// 存入缓存
if (env.CACHE_KV) {
await env.CACHE_KV.put(CACHE_KEY, JSON.stringify(collection), {
expirationTtl: CACHE_TTL,
});
}

return jsonResponse(collection, {
‘X-Cache’: ‘MISS’,
‘Cache-Control’: `public, max-age=${CACHE_TTL}`,
});
}

// ============================================
// 核心：缓存图片到 R2
// ============================================

async function cacheImageToR2(notionUrl, blockId, env) {
if (!notionUrl || !env.PHOTO_BUCKET) {
console.warn(‘⚠️ Missing URL or R2 bucket’);
return notionUrl;
}

const r2Key = `images/${blockId}.jpg`;

try {
// 1. 检查 R2 是否已有此图片
const existing = await env.PHOTO_BUCKET.head(r2Key);
if (existing) {
console.log(`✅ Image exists in R2: ${r2Key}`);
return `${env.PUBLIC_URL || ''}/images/${blockId}.jpg`;
}

```
console.log(`📥 Downloading image to R2: ${r2Key}`);

// 2. 下载 Notion 图片
const response = await fetch(notionUrl, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Cloudflare Worker)',
  },
});

if (!response.ok) {
  throw new Error(`Failed to fetch image: ${response.status}`);
}

// 3. 上传到 R2
await env.PHOTO_BUCKET.put(r2Key, response.body, {
  httpMetadata: {
    contentType: response.headers.get('Content-Type') || 'image/jpeg',
  },
});

console.log(`✅ Image cached to R2: ${r2Key}`);
return `${env.PUBLIC_URL || ''}/images/${blockId}.jpg`;
```

} catch (error) {
console.error(`❌ Failed to cache image to R2: ${r2Key}`, error);
// 降级：返回原始 URL
return notionUrl;
}
}

// ============================================
// Notion API 封装
// ============================================

async function notionQuery(databaseId, token) {
const response = await fetch(
`https://api.notion.com/v1/databases/${databaseId}/query`,
{
method: ‘POST’,
headers: {
‘Authorization’: `Bearer ${token}`,
‘Notion-Version’: ‘2022-06-28’,
‘Content-Type’: ‘application/json’,
},
body: JSON.stringify({
page_size: 100,
}),
}
);

if (!response.ok) {
throw new Error(`Notion API error: ${response.status}`);
}

return await response.json();
}

async function getPageInfo(pageId, token) {
const response = await fetch(
`https://api.notion.com/v1/pages/${pageId}`,
{
headers: {
‘Authorization’: `Bearer ${token}`,
‘Notion-Version’: ‘2022-06-28’,
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
‘Authorization’: `Bearer ${token}`,
‘Notion-Version’: ‘2022-06-28’,
},
}
);

if (!response.ok) {
throw new Error(`Failed to fetch page details: ${response.status}`);
}

return await response.json();
}

// ============================================
// 辅助函数
// ============================================

function extractImages(pageDetails) {
if (!pageDetails?.results) return [];

return pageDetails.results
.filter(block => block.type === ‘image’)
.map(block => ({
url: block.image?.file?.url || block.image?.external?.url || ‘’,
caption: block.image?.caption?.[0]?.plain_text || ‘’,
}))
.filter(img => img.url);
}

function jsonResponse(data, extraHeaders = {}) {
return new Response(JSON.stringify(data), {
headers: {
‘Content-Type’: ‘application/json’,
‘Access-Control-Allow-Origin’: ‘*’,
…extraHeaders,
},
});
}
