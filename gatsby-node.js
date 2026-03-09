const { createRequire } = require("module");

const PLUGIN_NAME = "gatsby-source-gallyn";

// Resolve gatsby-source-filesystem from the consuming site's node_modules
// (not from this plugin's directory, which has no node_modules).
let _createRemoteFileNode;
function getCreateRemoteFileNode(store) {
  if (!_createRemoteFileNode) {
    const siteDir = store.getState().program.directory;
    const siteRequire = createRequire(siteDir + "/package.json");
    _createRemoteFileNode =
      siteRequire("gatsby-source-filesystem").createRemoteFileNode;
  }
  return _createRemoteFileNode;
}

async function fetchJSON(url, headers) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(
      `${PLUGIN_NAME}: ${resp.status} ${resp.statusText} fetching ${url}`
    );
  }
  return resp.json();
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

const IMAGE_CACHE_KEY = `${PLUGIN_NAME}--image-cache`;

async function downloadAllImages(
  urls,
  { store, cache, createNode, createNodeId, getNode, reporter }
) {
  const createRemoteFileNode = getCreateRemoteFileNode(store);
  const cached = (await cache.get(IMAGE_CACHE_KEY)) || {};
  const imageMap = new Map();

  // Check cache — keep hits whose File node still exists
  const toDownload = [];
  for (const url of urls) {
    const cachedId = cached[url];
    if (cachedId && getNode(cachedId)) {
      imageMap.set(url, getNode(cachedId));
    } else {
      toDownload.push(url);
    }
  }

  reporter.info(
    `${PLUGIN_NAME}: Images — ${imageMap.size} cached, ${toDownload.length} to download`
  );

  // Download misses in parallel
  let downloaded = 0;
  const total = toDownload.length;
  await mapWithConcurrency(toDownload, 20, async (url) => {
    try {
      const fileNode = await createRemoteFileNode({
        url,
        store,
        cache,
        createNode,
        createNodeId,
        reporter,
      });
      imageMap.set(url, fileNode);
      cached[url] = fileNode.id;
    } catch (err) {
      reporter.warn(
        `${PLUGIN_NAME}: Failed to download image ${url} — ${err.message}`
      );
    }
    downloaded++;
    if (downloaded % 10 === 0 || downloaded === total) {
      reporter.info(`${PLUGIN_NAME}: Downloaded ${downloaded}/${total} images`);
    }
  });

  await cache.set(IMAGE_CACHE_KEY, cached);
  return imageMap;
}

/**
 * Create a child node with mediaType text/markdown so gatsby-transformer-remark
 * picks it up and creates a childMarkdownRemark node.
 */
function createMarkdownNode(
  parentId,
  fieldName,
  content,
  { createNode, createNodeId, createContentDigest }
) {
  if (!content || typeof content !== "string") return null;
  const nodeId = createNodeId(`${parentId}---${fieldName}-markdown`);
  createNode({
    id: nodeId,
    parent: parentId,
    children: [],
    internal: {
      type: "GallynMarkdownField",
      mediaType: "text/markdown",
      content,
      contentDigest: createContentDigest(content),
    },
  });
  return nodeId;
}

exports.createSchemaCustomization = ({ actions }) => {
  const { createTypes } = actions;
  createTypes(`
    type GallynHreflang {
      locale: String!
      slug: String!
    }

    type GallynAttachment {
      id: String!
      filename: String!
      url: String!
      altText: String
    }

    type GallynMarkdownField implements Node {
      id: ID!
    }

    type GallynOutlet implements Node @dontInfer {
      gallynId: String!
      name: String!
      logoFile: File @link(from: "logoFile___NODE", by: "id")
    }

    type GallynPage implements Node @dontInfer {
      gallynId: String!
      title: String!
      slug: String!
      pageType: String!
      locale: String!
      blurb: String
      heroImageFile: File @link(from: "heroImageFile___NODE", by: "id")
      videoUrl: String
      blockIndexing: Boolean
      publishedAt: Date @dateformat
      checkboxes: [String]
      cta: JSON
      testimonials: JSON
      pageCategory: String
      templateType: String
      showAttachments: Boolean
      showInFooter: Boolean
      autoplayVideo: Boolean
      sections: JSON
      body: GallynMarkdownField @link(from: "body___NODE", by: "id")
      intro: GallynMarkdownField @link(from: "intro___NODE", by: "id")
      why: GallynMarkdownField @link(from: "why___NODE", by: "id")
      solution: GallynMarkdownField @link(from: "solution___NODE", by: "id")
      fomo: GallynMarkdownField @link(from: "fomo___NODE", by: "id")
      outlet: GallynOutlet @link(from: "outlet___NODE", by: "id")
      relatedPages: [GallynRelatedPage] @link(from: "relatedPages___NODE", by: "id")
      attachments: [GallynAttachment]
      hreflang: [GallynHreflang]
      availableLocales: [String]
    }

    type GallynRelatedPage implements Node @dontInfer {
      gallynId: String!
      title: String!
      slug: String!
      blurb: String
      pageType: String!
      heroImageFile: File @link(from: "heroImageFile___NODE", by: "id")
    }

    type GallynBlogPost implements Node @dontInfer {
      gallynId: String!
      title: String!
      slug: String!
      locale: String!
      author: String
      description: String
      heroImageFile: File @link(from: "heroImageFile___NODE", by: "id")
      publishDate: Date @dateformat
      blockIndexing: Boolean
      tags: [GallynTag] @link(from: "tags___NODE", by: "id")
      body: GallynMarkdownField @link(from: "body___NODE", by: "id")
      rawBody: String
      hreflang: [GallynHreflang]
      availableLocales: [String]
    }

    type GallynLanguage implements Node @dontInfer {
      code: String!
      isDefault: Boolean!
    }

    type GallynTag implements Node @dontInfer {
      gallynId: String!
      name: String!
      slug: String!
      locale: String!
    }
  `);
};

exports.sourceNodes = async (
  { actions, createNodeId, createContentDigest, store, cache, getNode, reporter },
  pluginOptions
) => {
  const { createNode } = actions;
  const { apiUrl, apiKey, defaultLocale = "en" } = pluginOptions;

  if (!apiUrl || !apiKey) {
    reporter.panic(
      `${PLUGIN_NAME}: apiUrl and apiKey are required options. ` +
        `apiKey should be a wd_ delivery key (create in Settings > Web Delivery Keys).`
    );
    return;
  }

  const headers = { "X-API-Key": apiKey };
  const base = apiUrl.replace(/\/$/, "");
  const nodeHelpers = { createNode, createNodeId, createContentDigest };
  const imageHelpers = { store, cache, createNode, createNodeId, getNode, reporter };

  // 1. Fetch available languages
  let langResponse;
  try {
    langResponse = await fetchJSON(`${base}/delivery/web/languages`, headers);
  } catch (err) {
    reporter.panic(
      `${PLUGIN_NAME}: Failed to fetch languages — ${err.message}`
    );
    return;
  }

  const locales = langResponse.languages.map((l) => l.code);
  reporter.info(`${PLUGIN_NAME}: Found locales: ${locales.join(", ")}`);

  // 2. Create GallynLanguage nodes
  for (const lang of langResponse.languages) {
    const langNodeId = createNodeId(`GallynLanguage-${lang.code}`);
    createNode({
      code: lang.code,
      isDefault: lang.code === defaultLocale,
      id: langNodeId,
      internal: {
        type: "GallynLanguage",
        contentDigest: createContentDigest(lang),
      },
    });
  }

  // 3. Fetch tags for each locale
  // Map from "tagId-locale" → Gatsby node ID (for blog post linking)
  const tagNodeIdMap = new Map();
  let totalTags = 0;

  for (const locale of locales) {
    let tags = [];
    try {
      const tagResponse = await fetchJSON(
        `${base}/delivery/web/tags?locale=${locale}`,
        headers
      );
      tags = tagResponse.items || [];
    } catch (err) {
      reporter.warn(`${PLUGIN_NAME}: Failed to fetch tags for ${locale} — ${err.message}`);
    }

    for (const tag of tags) {
      const nodeId = createNodeId(`GallynTag-${tag.id}-${locale}`);
      tagNodeIdMap.set(`${tag.id}-${locale}`, nodeId);
      createNode({
        gallynId: tag.id,
        name: tag.name,
        slug: tag.slug,
        locale,
        id: nodeId,
        internal: {
          type: "GallynTag",
          contentDigest: createContentDigest({ ...tag, locale }),
        },
      });
    }
    totalTags += tags.length;
  }

  reporter.info(`${PLUGIN_NAME}: Created ${totalTags} GallynTag nodes`);

  // 4. Fetch pages and blog posts for each locale
  const allPages = [];
  const allBlogPosts = [];

  for (const locale of locales) {
    const [pageResponse, blogResponse] = await Promise.all([
      fetchJSON(
        `${base}/delivery/web/pages?locale=${locale}`,
        headers
      ).catch((err) => {
        reporter.warn(
          `${PLUGIN_NAME}: Failed to fetch pages for ${locale} — ${err.message}`
        );
        return { items: [] };
      }),
      fetchJSON(
        `${base}/delivery/web/blog?locale=${locale}`,
        headers
      ).catch((err) => {
        reporter.warn(
          `${PLUGIN_NAME}: Failed to fetch blog posts for ${locale} — ${err.message}`
        );
        return { items: [] };
      }),
    ]);

    const pages = pageResponse.items || [];
    const blogPosts = blogResponse.items || [];

    allPages.push(...pages.map((p) => ({ ...p, locale })));
    allBlogPosts.push(...blogPosts.map((p) => ({ ...p, locale })));
  }

  // 5. Build hreflang maps
  const pageHreflangMap = buildHreflangMap(allPages, defaultLocale);
  const blogHreflangMap = buildHreflangMap(allBlogPosts, defaultLocale);

  // 6. Download all images (deduplicated + cached + parallel)
  const allImageUrls = new Set();
  for (const page of allPages) {
    if (page.hero_image_url) allImageUrls.add(page.hero_image_url);
    for (const rp of page.related_pages || []) {
      if (rp.hero_image_url) allImageUrls.add(rp.hero_image_url);
    }
    if (page.outlet?.logo_url) allImageUrls.add(page.outlet.logo_url);
  }
  for (const post of allBlogPosts) {
    if (post.hero_image_url) allImageUrls.add(post.hero_image_url);
  }
  const imageMap = await downloadAllImages([...allImageUrls], imageHelpers);

  // 7. Create deduplicated GallynOutlet nodes
  const outletNodeIdMap = new Map();
  for (const page of allPages) {
    const outlet = page.outlet;
    if (!outlet || outletNodeIdMap.has(outlet.id)) continue;
    const outletNodeId = createNodeId(`GallynOutlet-${outlet.id}`);
    const logoFile = imageMap.get(outlet.logo_url) || null;
    createNode({
      gallynId: outlet.id,
      name: outlet.name,
      logoFile___NODE: logoFile ? logoFile.id : null,
      id: outletNodeId,
      internal: {
        type: "GallynOutlet",
        contentDigest: createContentDigest(outlet),
      },
    });
    outletNodeIdMap.set(outlet.id, outletNodeId);
  }

  reporter.info(`${PLUGIN_NAME}: Created ${outletNodeIdMap.size} GallynOutlet nodes`);

  // 8. Create GallynPage nodes
  for (const page of allPages) {
    const hreflangKey = page.id;
    const hreflang = pageHreflangMap.get(hreflangKey) || [];
    const availableLocales = hreflang.map((h) => h.locale);
    const pageNodeId = createNodeId(`GallynPage-${page.id}-${page.locale}`);

    // Look up hero image from pre-downloaded map
    const heroFile = imageMap.get(page.hero_image_url) || null;

    // Create related page nodes (with their own hero images)
    const relatedPageNodeIds = [];
    for (const rp of page.related_pages || []) {
      const rpNodeId = createNodeId(
        `GallynRelatedPage-${page.id}-${rp.id}-${page.locale}`
      );
      const rpHeroFile = imageMap.get(rp.hero_image_url) || null;
      createNode({
        gallynId: rp.id,
        title: rp.title,
        slug: rp.slug,
        blurb: rp.blurb || null,
        pageType: rp.page_type,
        heroImageFile___NODE: rpHeroFile ? rpHeroFile.id : null,
        id: rpNodeId,
        internal: {
          type: "GallynRelatedPage",
          contentDigest: createContentDigest(rp),
        },
      });
      relatedPageNodeIds.push(rpNodeId);
    }

    // Create markdown child nodes for each section field
    const sectionLinks = {};
    for (const [key, value] of Object.entries(page.sections || {})) {
      if (typeof value === "string" && value.trim()) {
        const mdNodeId = createMarkdownNode(
          pageNodeId,
          key,
          value,
          nodeHelpers
        );
        if (mdNodeId) {
          sectionLinks[`${key}___NODE`] = mdNodeId;
        }
      }
    }

    createNode({
      gallynId: page.id,
      title: page.title,
      slug: page.slug,
      pageType: page.page_type,
      locale: page.locale,
      blurb: page.blurb || null,
      heroImageFile___NODE: heroFile ? heroFile.id : null,
      videoUrl: page.video_url || null,
      blockIndexing: page.block_indexing || false,
      publishedAt: page.published_at || null,
      // Flattened meta fields
      checkboxes: page.checkboxes || [],
      cta: page.cta || null,
      testimonials: page.testimonials || [],
      pageCategory: page.page_category || null,
      templateType: page.template_type || null,
      showAttachments: page.show_attachments || false,
      showInFooter: page.show_in_footer || false,
      autoplayVideo: page.autoplay_video || false,
      // Sections as raw JSON (for direct access)
      sections: page.sections || {},
      // Resolved references
      outlet___NODE: page.outlet ? outletNodeIdMap.get(page.outlet.id) || null : null,
      relatedPages___NODE: relatedPageNodeIds,
      attachments: (page.attachments || []).map((a) => ({
        id: a.id,
        filename: a.filename,
        url: a.url,
        altText: a.alt_text || null,
      })),
      hreflang,
      availableLocales,
      // Section markdown child nodes (intro___NODE, why___NODE, etc.)
      ...sectionLinks,
      // Gatsby internals
      id: pageNodeId,
      internal: {
        type: "GallynPage",
        contentDigest: createContentDigest(page),
      },
    });
  }

  reporter.info(`${PLUGIN_NAME}: Created ${allPages.length} GallynPage nodes`);

  // 9. Create GallynBlogPost nodes
  for (const post of allBlogPosts) {
    const hreflangKey = post.id;
    const hreflang = blogHreflangMap.get(hreflangKey) || [];
    const availableLocales = hreflang.map((h) => h.locale);
    const postNodeId = createNodeId(`GallynBlogPost-${post.id}-${post.locale}`);

    // Look up hero image from pre-downloaded map
    const heroFile = imageMap.get(post.hero_image_url) || null;

    // Create markdown child node for body
    const bodyNodeId = createMarkdownNode(
      postNodeId,
      "body",
      post.body,
      nodeHelpers
    );

    // Map tag IDs to Gatsby node IDs (locale-aware)
    const tagNodeIds = (post.tags || [])
      .map((t) => tagNodeIdMap.get(`${t.id}-${post.locale}`))
      .filter(Boolean);

    createNode({
      gallynId: post.id,
      title: post.title,
      slug: post.slug,
      locale: post.locale,
      author: post.author || null,
      description: post.description || null,
      heroImageFile___NODE: heroFile ? heroFile.id : null,
      publishDate: post.publish_date || null,
      blockIndexing: post.block_indexing || false,
      tags___NODE: tagNodeIds,
      body___NODE: bodyNodeId,
      rawBody: post.body || "",
      hreflang,
      availableLocales,
      id: postNodeId,
      internal: {
        type: "GallynBlogPost",
        contentDigest: createContentDigest(post),
      },
    });
  }

  reporter.info(
    `${PLUGIN_NAME}: Created ${allBlogPosts.length} GallynBlogPost nodes`
  );
};

/**
 * Build a map from base content ID to array of {locale, slug} for hreflang tags.
 */
function buildHreflangMap(items, defaultLocale) {
  const map = new Map();

  for (const item of items) {
    const baseId = item.id;
    if (!map.has(baseId)) {
      map.set(baseId, []);
    }

    const isDefault = item.locale === defaultLocale;
    const slug = isDefault
      ? `/${item.slug}`
      : `/${item.locale}/${item.slug}`;

    map.get(baseId).push({
      locale: item.locale,
      slug,
    });
  }

  return map;
}
