// On-device audit. In the Android app, CapacitorHttp makes fetch() native,
// so it can read any website without CORS limits and without a server.

const STOP = new Set("a about above after again all am an and any are as at be because been before being below between both but by can did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up us very was we were what when where which while who why will with you your".split(" "));

async function getUrl(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    const text = await res.text();
    return { ok: res.ok, status: res.status, url: res.url || url, ms: Date.now() - start, text, headers: res.headers };
  } catch (e) {
    return { ok: false, status: 0, url, ms: Date.now() - start, text: "", error: e.name === "AbortError" ? "Timed out" : e.message };
  } finally { clearTimeout(t); }
}

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

function keywordsFrom(text, boost) {
  const words = (text.toLowerCase().match(/[a-zÀ-ɏ]{3,}/g) || []).filter((w) => !STOP.has(w));
  const one = {}, two = {};
  words.forEach((w, i) => {
    one[w] = (one[w] || 0) + 1;
    if (words[i + 1]) { const p = w + " " + words[i + 1]; two[p] = (two[p] || 0) + 1; }
  });
  const bw = new Set((boost.toLowerCase().match(/[a-zÀ-ɏ]{3,}/g) || []).filter((w) => !STOP.has(w)));
  const rank = (map) => Object.entries(map)
    .map(([k, n]) => [k, n + (k.split(" ").some((w) => bw.has(w)) ? 3 : 0)])
    .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([term, score]) => ({ term, score }));
  return { total: words.length, single: rank(one), phrases: rank(Object.fromEntries(Object.entries(two).filter(([, n]) => n > 1))) };
}

function analyze(html, finalUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const meta = (attr, val) => { const m = doc.querySelector(`meta[${attr}="${val}" i]`); return m ? clean(m.getAttribute("content")) : null; };
  const title = clean(doc.querySelector("title")?.textContent);
  const description = meta("name", "description");
  const canonical = doc.querySelector('link[rel="canonical" i]')?.getAttribute("href") || "";
  const og = {}; ["og:title", "og:description", "og:image", "og:type"].forEach((k) => (og[k] = meta("property", k)));

  const headings = {}, list = [];
  [1, 2, 3, 4].forEach((l) => {
    const els = [...doc.querySelectorAll("h" + l)].map((h) => clean(h.textContent)).filter(Boolean);
    headings["h" + l] = els.length;
    if (l <= 2) els.slice(0, 12).forEach((t) => list.push({ level: l, text: t.slice(0, 120) }));
  });
  const h1s = [...doc.querySelectorAll("h1")].map((h) => clean(h.textContent)).filter(Boolean);

  const imgs = [...doc.querySelectorAll("img")];
  let host = ""; try { host = new URL(finalUrl).hostname.replace(/^www\./, ""); } catch {}
  const links = { internal: 0, external: 0, tel: 0, mail: 0 };
  doc.querySelectorAll("a[href]").forEach((a) => {
    const h = a.getAttribute("href") || "";
    if (!h || h.startsWith("#") || /^(javascript:|sms:)/i.test(h)) return;
    if (h.startsWith("tel:")) links.tel++;
    else if (h.startsWith("mailto:")) links.mail++;
    else if (/^https?:\/\//i.test(h)) { try { new URL(h).hostname.replace(/^www\./, "") === host ? links.internal++ : links.external++; } catch {} }
    else links.internal++;
  });

  doc.querySelectorAll("script,style,noscript").forEach((n) => n.remove());
  const text = clean(doc.body?.textContent || "");
  const kw = keywordsFrom(text, title + " " + h1s.join(" "));

  // schema (read from the original html because scripts were removed above)
  const types = new Set(); let blocks = 0, invalid = 0;
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n["@type"]) [].concat(n["@type"]).forEach((t) => types.add(String(t)));
    Object.values(n).forEach((v) => typeof v === "object" && walk(v));
  };
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    blocks++; try { walk(JSON.parse(m[1].trim())); } catch { invalid++; }
  }

  return {
    title, titleLen: title.length, description, descriptionLen: (description || "").length,
    keywordsMeta: meta("name", "keywords"), robotsMeta: meta("name", "robots"), viewport: meta("name", "viewport"),
    canonical, lang: doc.documentElement.getAttribute("lang") || "", og, twitterCard: meta("name", "twitter:card"),
    favicon: !!doc.querySelector('link[rel*="icon" i]'),
    headings, h1s, headingList: list,
    images: { total: imgs.length, missingAlt: imgs.filter((i) => !clean(i.getAttribute("alt"))).length, lazy: imgs.filter((i) => i.getAttribute("loading") === "lazy").length },
    links, words: text.split(/\s+/).filter(Boolean).length, keywords: kw,
    schema: { blocks, invalid, types: [...types], microdata: /itemtype\s*=\s*["']https?:\/\/schema\.org\//i.test(html) },
    nap: { phone: /(\+?\d[\d\s().-]{8,}\d)/.test(text) || links.tel > 0, address: /\b(street|st\.|road|rd\.|avenue|ave\.|lane|suite|floor|block|sector|plaza)\b/i.test(text) },
  };
}

function robotsInfo(txt) {
  const lines = txt.split(/\r?\n/).map((l) => l.trim());
  let agent = "", disallowAll = false, disallows = 0;
  const sitemaps = [];
  for (const l of lines) {
    if (/^user-agent:/i.test(l)) agent = l.split(":")[1].trim();
    else if (/^disallow:\s*\S+/i.test(l)) { disallows++; if (/^disallow:\s*\/\s*$/i.test(l) && agent === "*") disallowAll = true; }
    else if (/^sitemap:/i.test(l)) sitemaps.push(l.replace(/^sitemap:\s*/i, ""));
  }
  return { sitemaps, disallowAll, disallows, preview: lines.filter(Boolean).slice(0, 14) };
}

async function auditSite(input) {
  let s = String(input || "").trim();
  if (!s) throw new Error("Enter a website address.");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u; try { u = new URL(s); } catch { throw new Error("That address is not valid."); }
  const page = await getUrl(u.href);
  if (!page.text) throw new Error(page.error ? "Could not load the site: " + page.error : "Site answered with status " + page.status + ".");
  const final = new URL(page.url);
  const origin = final.origin;
  const [robots, sitemap, httpTry] = await Promise.all([
    getUrl(origin + "/robots.txt", 8000),
    getUrl(origin + "/sitemap.xml", 8000),
    final.protocol === "https:" ? getUrl("http://" + final.host + "/", 8000) : Promise.resolve(null),
  ]);
  const isText = robots.ok && !/<html/i.test(robots.text.slice(0, 500));
  const rob = isText ? robotsInfo(robots.text) : {};
  const sm = sitemap.ok && /<(urlset|sitemapindex)/i.test(sitemap.text);
  return {
    finalUrl: page.url, status: page.status, https: final.protocol === "https:",
    httpRedirectsToHttps: httpTry && httpTry.url && httpTry.url !== "http://" + final.host + "/" ? /^https:/i.test(httpTry.url) : null,
    server: { responseMs: page.ms, htmlKb: Math.round(new Blob([page.text]).size / 1024), compressed: !!page.headers?.get?.("content-encoding") },
    page: analyze(page.text, page.url),
    robots: { found: isText, ...rob },
    sitemap: { found: sm, urls: sm ? (sitemap.text.match(/<loc>/g) || []).length : 0, url: origin + "/sitemap.xml" },
  };
}

async function auditGbp(input) {
  let raw = String(input || "").trim();
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  let u; try { u = new URL(raw); } catch { throw new Error("That link is not valid."); }
  if (!/(^|\.)(google\.[a-z.]+|goo\.gl|g\.page|g\.co)$/i.test(u.hostname)) throw new Error("That does not look like a Google Maps or Business Profile link.");
  const r = await getUrl(raw, 10000);
  const finalUrl = r.url || raw;
  let dec = finalUrl; try { dec = decodeURIComponent(finalUrl); } catch {}
  const m = dec.match(/\/maps\/place\/([^/@?]+)/);
  const title = clean((r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  return { name: m ? m[1].replace(/\+/g, " ") : "", title, finalUrl, cid: (finalUrl.match(/[?&]cid=(\d+)/) || [])[1] || "" };
}
