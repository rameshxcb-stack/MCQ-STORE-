// lib/mcq-generator.js

/**
 * Advanced PDF-Capable Evidence Retriever (High Resiliency)
 * Strategy: DDG HTML Scraper -> Jina Reader (PDF/HTML) -> Jina Search -> Wikipedia -> Default Fallback
 */
async function retrieveEvidence(subject, chapter) {
  // Helper: Serverless hanging se bachne ke liye timeout wrapper
  const fetchWithTimeout = async (url, options = {}, timeoutMs = 5000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      return response;
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  };

  let targetUrl = null;

  // 1. DuckDuckGo HTML Search se NCERT PDF / Page ka असली Direct URL nikalen
  try {
    const searchQuery = `site:ncert.nic.in ${subject} ${chapter} pdf textbook`;
    const ddgHtmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;

    const ddgRes = await fetchWithTimeout(ddgHtmlUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }, 4000);

    if (ddgRes.ok) {
      const htmlText = await ddgRes.text();

      // 🛡️ Safety Check: Agar DuckDuckGo ne CAPTCHA ya Block kar diya, toh seedha Backup par switch karein
      if (htmlText.toLowerCase().includes('captcha') || htmlText.includes('403')) {
        throw new Error("DDG returned CAPTCHA/Block. Skipping to backup.");
      }

      // Single aur double quotes dono ke liye optimized regex match
      const uddgMatches = htmlText.match(/uddg=([^&"']+)/g);

      if (uddgMatches && uddgMatches.length > 0) {
        for (const match of uddgMatches) {
          const decodedUrl = decodeURIComponent(match.replace('uddg=', ''));
          if (decodedUrl.includes('ncert.nic.in')) {
            targetUrl = decodedUrl;
            break;
          }
        }
        // Agar ncert.nic.in direct na mile, to pehla search result le lo
        if (!targetUrl) {
          targetUrl = decodeURIComponent(uddgMatches[0].replace('uddg=', ''));
        }
      }
    }
  } catch (e) {
    console.warn("⚠️ DDG Link Scraper failed or blocked:", e.message);
  }

  // 2. 🚀 Jina Reader (`r.jina.ai`) se PDF ya HTML URL ka Full Text extract karein
  if (targetUrl) {
    try {
      console.log(`🔗 Target NCERT URL Found: ${targetUrl}`);
      const readerUrl = `https://r.jina.ai/${targetUrl}`;
      
      // PDF processing ke liye 7s timeout
      const jinaRes = await fetchWithTimeout(readerUrl, { headers: { 'X-No-Cache': 'true' } }, 7000);

      if (jinaRes.ok) {
        const fullText = await jinaRes.text();
        
        if (fullText && fullText.length > 300 && !fullText.toLowerCase().includes('not found')) {
          const cleanedText = fullText
            .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // Markdown Links Remove
            .replace(/https?:\/\/\S+/g, '')          // Raw URLs Remove
            .replace(/[#*`_~]/g, '')                 // Formatting Tags Remove
            .replace(/\s+/g, ' ')                    // Space Normalization
            .trim();

          console.log(`✅ Jina Reader parsed full PDF/HTML content for: ${subject} - ${chapter}`);
          return cleanedText.substring(0, 4000);
        }
      }
    } catch (e) {
      console.warn(`⚠️ Jina Reader failed for URL ${targetUrl}:`, e.message);
    }
  }

  // 3. Backup 1: Jina Direct Search (`s.jina.ai`) agar DDG URL block ya fail ho jaye
  try {
    const backupQuery = `NCERT ${subject} ${chapter} textbook chapter detailed notes`;
    const backupUrl = `https://s.jina.ai/${encodeURIComponent(backupQuery)}`;
    const backupRes = await fetchWithTimeout(backupUrl, { headers: { 'X-No-Cache': 'true' } }, 5000);

    if (backupRes.ok) {
      const text = await backupRes.text();
      if (text && text.length > 200) {
        const cleaned = text
          .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
          .replace(/https?:\/\/\S+/g, '')
          .replace(/[#*`_~]/g, '')
          .replace(/\s+/g, ' ')
          .trim();

        console.log(`✅ Backup: Jina Search content fetched for ${subject} - ${chapter}`);
        return cleaned.substring(0, 3500);
      }
    }
  } catch (e) {
    console.warn("⚠️ Jina Search backup failed:", e.message);
  }

  // 4. Backup 2: Wikipedia REST API
  try {
    const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(chapter)}`;
    const wikiRes = await fetchWithTimeout(wikiUrl, {}, 3000);
    if (wikiRes.ok) {
      const wikiData = await wikiRes.json();
      if (wikiData.extract && wikiData.extract.length > 50) {
        console.log(`✅ Backup: Wikipedia Text for ${subject} - ${chapter}`);
        return wikiData.extract;
      }
    }
  } catch (e) {
    console.warn("⚠️ Wikipedia fallback failed:", e.message);
  }

  // 5. Final Fallback
  console.warn(`⚠️ Using default fallback for ${subject} - ${chapter}`);
  return `Educational curriculum evidence for ${subject} - ${chapter}.`;
}
