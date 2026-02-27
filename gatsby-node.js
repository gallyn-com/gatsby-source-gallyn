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

/**
 * Download an image via createRemoteFileNode, returning the File node or null.
 */
async function downloadImage(
  url,
  { store, cache, createNode, createNodeId, reporter }
) {
  if (!url) return null;
  const createRemoteFileNode = getCreateRemoteFileNode(store);
  try {
    return await createRemoteFileNode({
      url,
      store,
      cache,
      createNode,
      createNodeId,
      reporter,
    });
  } catch (err) {
    reporter.warn(
      `${PLUGIN_NAME}: Failed to download image ${url} — ${err.message}`
    );
    return null;
  }
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
      childMarkdownRemark: MarkdownRemark @link
    }

    type GallynPage implements Node {
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
      relatedPages: [GallynRelatedPage] @link(from: "relatedPages___NODE", by: "id")
      attachments: [GallynAttachment]
      hreflang: [GallynHreflang]
      availableLocales: [String]
    }

    type GallynRelatedPage implements Node {
      gallynId: String!
      title: String!
      slug: String!
      blurb: String
      pageType: String!
      heroImageFile: File @link(from: "heroImageFile___NODE", by: "id")
    }

    type GallynBlogPost implements Node {
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

    type GallynTag implements Node {
      gallynId: String!
      name: String!
      slug: String!
    }
  `);
};

exports.sourceNodes = async (
  { actions, createNodeId, createContentDigest, store, cache, reporter },
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
  const imageHelpers = { store, cache, createNode, createNodeId, reporter };

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

  // 2. Fetch tags for default locale
  let tags = [];
  try {
    const tagResponse = await fetchJSON(
      `${base}/delivery/web/tags?locale=${defaultLocale}`,
      headers
    );
    tags = tagResponse.items || [];
  } catch (err) {
    reporter.warn(`${PLUGIN_NAME}: Failed to fetch tags — ${err.message}`);
  }

  // Map from Gallyn tag ID → Gatsby node ID (for blog post linking)
  const tagNodeIdMap = new Map();

  for (const tag of tags) {
    const nodeId = createNodeId(`GallynTag-${tag.id}`);
    tagNodeIdMap.set(tag.id, nodeId);
    createNode({
      gallynId: tag.id,
      name: tag.name,
      slug: tag.slug,
      id: nodeId,
      internal: {
        type: "GallynTag",
        contentDigest: createContentDigest(tag),
      },
    });
  }

  reporter.info(`${PLUGIN_NAME}: Created ${tags.length} GallynTag nodes`);

  // 3. Fetch pages and blog posts for each locale
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

  // 4. Build hreflang maps
  const pageHreflangMap = buildHreflangMap(allPages, defaultLocale);
  const blogHreflangMap = buildHreflangMap(allBlogPosts, defaultLocale);

  // 5. Create GallynPage nodes
  for (const page of allPages) {
    const hreflangKey = page.id.replace(/-[a-z]{2}$/, "");
    const hreflang = pageHreflangMap.get(hreflangKey) || [];
    const availableLocales = hreflang.map((h) => h.locale);
    const pageNodeId = createNodeId(`GallynPage-${page.id}`);

    // Download hero image
    const heroFile = await downloadImage(page.hero_image_url, imageHelpers);

    // Create related page nodes (with their own hero images)
    const relatedPageNodeIds = [];
    for (const rp of page.related_pages || []) {
      const rpNodeId = createNodeId(
        `GallynRelatedPage-${page.id}-${rp.id}`
      );
      const rpHeroFile = await downloadImage(rp.hero_image_url, imageHelpers);
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

  // 6. Create GallynBlogPost nodes
  for (const post of allBlogPosts) {
    const hreflangKey = post.id.replace(/-[a-z]{2}$/, "");
    const hreflang = blogHreflangMap.get(hreflangKey) || [];
    const availableLocales = hreflang.map((h) => h.locale);
    const postNodeId = createNodeId(`GallynBlogPost-${post.id}`);

    // Download hero image
    const heroFile = await downloadImage(post.hero_image_url, imageHelpers);

    // Create markdown child node for body
    const bodyNodeId = createMarkdownNode(
      postNodeId,
      "body",
      post.body,
      nodeHelpers
    );

    // Map tag IDs to Gatsby node IDs
    const tagNodeIds = (post.tags || [])
      .map((t) => tagNodeIdMap.get(t.id))
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
    const baseId = item.id.replace(/-[a-z]{2}$/, "");
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
