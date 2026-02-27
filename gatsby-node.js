const fetch = require("node-fetch");
const { createRemoteFileNode } = require("gatsby-source-filesystem");

const PLUGIN_NAME = "gatsby-source-gallyn";

async function fetchJSON(url, headers) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(
      `${PLUGIN_NAME}: ${resp.status} ${resp.statusText} fetching ${url}`
    );
  }
  return resp.json();
}

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

  // wd_ delivery keys embed tenant + site context — only X-API-Key needed
  const headers = {
    "X-API-Key": apiKey,
  };

  const base = apiUrl.replace(/\/$/, "");

  // 1. Fetch available languages
  let locales;
  try {
    locales = await fetchJSON(`${base}/delivery/web/languages`, headers);
  } catch (err) {
    reporter.panic(`${PLUGIN_NAME}: Failed to fetch languages — ${err.message}`);
    return;
  }

  reporter.info(`${PLUGIN_NAME}: Found locales: ${locales.join(", ")}`);

  // 2. Fetch tags for default locale
  let tags = [];
  try {
    tags = await fetchJSON(
      `${base}/delivery/web/tags?locale=${defaultLocale}`,
      headers
    );
  } catch (err) {
    reporter.warn(`${PLUGIN_NAME}: Failed to fetch tags — ${err.message}`);
  }

  for (const tag of tags) {
    createNode({
      ...tag,
      id: createNodeId(`GallynTag-${tag.id}`),
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
    const [pages, blogPosts] = await Promise.all([
      fetchJSON(`${base}/delivery/web/pages?locale=${locale}`, headers).catch(
        (err) => {
          reporter.warn(
            `${PLUGIN_NAME}: Failed to fetch pages for ${locale} — ${err.message}`
          );
          return [];
        }
      ),
      fetchJSON(`${base}/delivery/web/blog?locale=${locale}`, headers).catch(
        (err) => {
          reporter.warn(
            `${PLUGIN_NAME}: Failed to fetch blog posts for ${locale} — ${err.message}`
          );
          return [];
        }
      ),
    ]);

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

    let heroImageFile = null;
    if (page.heroImage) {
      try {
        heroImageFile = await createRemoteFileNode({
          url: page.heroImage,
          store,
          cache,
          createNode,
          createNodeId,
          reporter,
        });
      } catch (err) {
        reporter.warn(
          `${PLUGIN_NAME}: Failed to download hero image for page ${page.slug} — ${err.message}`
        );
      }
    }

    const nodeData = {
      ...page,
      hreflang,
      availableLocales,
      heroImageFile___NODE: heroImageFile ? heroImageFile.id : null,
      id: createNodeId(`GallynPage-${page.id}`),
      internal: {
        type: "GallynPage",
        contentDigest: createContentDigest(page),
      },
    };

    createNode(nodeData);
  }

  reporter.info(`${PLUGIN_NAME}: Created ${allPages.length} GallynPage nodes`);

  // 6. Create GallynBlogPost nodes
  for (const post of allBlogPosts) {
    const hreflangKey = post.id.replace(/-[a-z]{2}$/, "");
    const hreflang = blogHreflangMap.get(hreflangKey) || [];
    const availableLocales = hreflang.map((h) => h.locale);

    let heroImageFile = null;
    if (post.heroImage) {
      try {
        heroImageFile = await createRemoteFileNode({
          url: post.heroImage,
          store,
          cache,
          createNode,
          createNodeId,
          reporter,
        });
      } catch (err) {
        reporter.warn(
          `${PLUGIN_NAME}: Failed to download hero image for blog post ${post.slug} — ${err.message}`
        );
      }
    }

    const nodeData = {
      ...post,
      hreflang,
      availableLocales,
      heroImageFile___NODE: heroImageFile ? heroImageFile.id : null,
      id: createNodeId(`GallynBlogPost-${post.id}`),
      internal: {
        type: "GallynBlogPost",
        contentDigest: createContentDigest(post),
      },
    };

    createNode(nodeData);
  }

  reporter.info(
    `${PLUGIN_NAME}: Created ${allBlogPosts.length} GallynBlogPost nodes`
  );
};

exports.createPages = async ({ graphql, actions, reporter }) => {
  const { createPage } = actions;

  // Query all pages
  const pagesResult = await graphql(`
    query {
      allGallynPage {
        nodes {
          slug
          locale
          pageType
          id
        }
      }
    }
  `);

  if (pagesResult.errors) {
    reporter.panic(
      `${PLUGIN_NAME}: Error querying GallynPage nodes`,
      pagesResult.errors
    );
    return;
  }

  const templates = {
    landing: "./src/templates/landing-page.js",
    static: "./src/templates/static-page.js",
    case_study: "./src/templates/case-study.js",
  };

  for (const node of pagesResult.data.allGallynPage.nodes) {
    const isDefault = node.locale === "en";
    const pagePath = isDefault
      ? `/${node.slug}`
      : `/${node.locale}/${node.slug}`;

    createPage({
      path: pagePath,
      component: require.resolve(
        templates[node.pageType] || templates.static
      ),
      context: {
        id: node.id,
        slug: node.slug,
        locale: node.locale,
      },
    });
  }

  reporter.info(
    `${PLUGIN_NAME}: Created ${pagesResult.data.allGallynPage.nodes.length} pages`
  );

  // Query all blog posts
  const blogResult = await graphql(`
    query {
      allGallynBlogPost {
        nodes {
          slug
          locale
          id
        }
      }
    }
  `);

  if (blogResult.errors) {
    reporter.panic(
      `${PLUGIN_NAME}: Error querying GallynBlogPost nodes`,
      blogResult.errors
    );
    return;
  }

  for (const node of blogResult.data.allGallynBlogPost.nodes) {
    const isDefault = node.locale === "en";
    const postPath = isDefault
      ? `/${node.slug}`
      : `/${node.locale}/${node.slug}`;

    createPage({
      path: postPath,
      component: require.resolve("./src/templates/blog-post.js"),
      context: {
        id: node.id,
        slug: node.slug,
        locale: node.locale,
      },
    });
  }

  reporter.info(
    `${PLUGIN_NAME}: Created ${blogResult.data.allGallynBlogPost.nodes.length} blog post pages`
  );
};

/**
 * Build a map from base content ID to array of {locale, slug} for hreflang tags.
 * Assumes each content item has an `id` that ends with `-{locale}` suffix,
 * and the base ID (without the locale suffix) groups translations together.
 */
function buildHreflangMap(items, defaultLocale) {
  const map = new Map();

  for (const item of items) {
    // Strip locale suffix to get the base content ID
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
      slug: slug,
    });
  }

  return map;
}
