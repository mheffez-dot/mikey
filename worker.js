export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Serve static assets
    if (request.method === 'GET') {
      return env.ASSETS.fetch(request);
    }

    // Handle form submission
    if (request.method === 'POST' && url.pathname === '/validate') {
      try {
        const formData = await request.formData();
        const csvFile = formData.get('domains_csv');

        if (!csvFile) {
          return new Response(JSON.stringify({ error: 'No CSV file provided' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const csvText = await csvFile.text();
        const domains = parseCSV(csvText);

        const results = [];
        for (const domain of domains) {
          const result = await validateDomain(domain, env);
          results.push(result);
        }

        return new Response(JSON.stringify({ results }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (error) {
        console.error('Validation error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Return 404 for any other routes with proper JSON error
    if (request.method === 'POST') {
      return new Response(JSON.stringify({ error: `Endpoint not found: ${url.pathname}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return env.ASSETS.fetch(request);
  },
};

function parseCSV(text) {
  const lines = text.split('\n').filter(line => line.trim());
  const domains = [];

  for (const line of lines) {
    // Skip header row if it contains common headers
    const lowerLine = line.toLowerCase().trim();
    if (lowerLine.includes('domain') || lowerLine.includes('url') || lowerLine.includes('website')) {
      continue;
    }

    // Extract domain from the line
    const domain = extractDomain(line.trim());
    if (domain) {
      domains.push(domain);
    }
  }

  return domains;
}

function extractDomain(input) {
  // Remove protocol and www
  let domain = input.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  // Remove trailing slashes and paths
  domain = domain.split('/')[0];
  // Remove query strings
  domain = domain.split('?')[0];
  // Validate it looks like a domain
  if (domain.match(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i)) {
    return domain.toLowerCase();
  }
  return null;
}

async function validateDomain(domain, env) {
  const url = domain.startsWith('http') ? domain : `https://${domain}`;

  try {
    // Step 1: Fetch Website - Try HTTPS first, then HTTP as fallback
    let html = '';
    let statusCode = 0;
    let usedUrl = url;

    const fetchOptions = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
    };

    // Try HTTPS first
    try {
      const response = await fetch(url, fetchOptions);
      statusCode = response.status;
      usedUrl = response.url;
      if (statusCode === 200) {
        html = await response.text();
      }
    } catch (directError) {
      console.log(`Direct HTTPS fetch failed for ${domain}, trying HTTP`);
    }

    // Try HTTP as fallback if HTTPS didn't work
    if (!html || statusCode !== 200) {
      const httpUrl = `http://${domain}`;
      try {
        const response = await fetch(httpUrl, fetchOptions);
        statusCode = response.status;
        usedUrl = response.url;
        if (statusCode === 200) {
          html = await response.text();
        }
      } catch (httpError) {
        console.log(`Direct HTTP fetch also failed for ${domain}`);
      }
    }

    // If direct fetch failed or returned non-200, try Bright Data Web Unblocker
    if (!html || statusCode !== 200) {
      try {
        const brightDataUrl = `https://api.brightdata.com/unblocker?url=${encodeURIComponent(url)}`;
        const response = await fetch(brightDataUrl, {
          headers: {
            'Authorization': `Bearer ${env.BRIGHT_DATA_API_KEY}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });
        if (response.ok) {
          html = await response.text();
          statusCode = response.status;
        }
      } catch (brightDataError) {
        console.log(`Bright Data fetch also failed for ${domain}: ${brightDataError.message}`);
      }
    }

    // If we still don't have content, return review status
    if (!html || statusCode !== 200) {
      return {
        domain,
        verdict: 'Mixed',
        confidence: 50,
        category: 'Unable to fetch',
        evidence: [],
        reason: `Website unreachable (status: ${statusCode}). Manual review required.`,
        extracted: { title: '', description: '', products: [] },
        covered: [],
        excluded: []
      };
    }

    // Step 2: Read & Classify - Extract content
    const extracted = extractContent(html);

    // Use DeepSeek AI to classify
    const classification = await classifyWithAI(extracted, domain, env);

    // Map verdict to covered/excluded arrays for frontend display
    const covered = classification.verdict === 'Pass' ? [classification.category] : [];
    const excluded = classification.verdict === 'Fail' ? [classification.category] : [];

    // Step 3: Return Verdict
    return {
      domain,
      verdict: classification.verdict,
      confidence: classification.confidence,
      category: classification.category,
      evidence: classification.evidence,
      reason: classification.reason,
      covered,
      excluded,
      extracted: {
        title: extracted.title,
        description: extracted.description,
        products: extracted.products.slice(0, 10),
      },
    };
  } catch (error) {
    return {
      domain,
      verdict: 'Mixed',
      confidence: 50,
      category: 'Error',
      evidence: [],
      reason: `Failed to validate: ${error.message}. Manual review required.`,
      covered: [],
      excluded: [],
      extracted: { title: '', description: '', products: [] },
    };
  }
}

function extractContent(html) {
  // Simple HTML parsing without external libraries
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
  const description = descMatch ? descMatch[1].trim() : '';

  // Extract potential product-related text
  const products = [];
  const productPatterns = [
    /<h[1-6][^>]*>([^<]*(?:product|item|shop|store|buy|sale)[^<]*)<\/h[1-6]>/gi,
    /<a[^>]*>([^<]*(?:product|item|shop|store|buy|sale)[^<]*)<\/a>/gi,
    /<span[^>]*>([^<]*(?:product|item|shop|store|buy|sale)[^<]*)<\/span>/gi,
  ];

  for (const pattern of productPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const text = match[1].trim();
      if (text.length > 5 && text.length < 100 && !products.includes(text)) {
        products.push(text);
      }
    }
  }

  return { title, description, products };
}

async function classifyWithAI(extracted, domain, env) {
  // CPS Coverage Policy:
  // Covered: Powered/durable high-ticket goods (electronics, appliances, tools, firearms)
  // Excluded: Apparel, food, services, software

  const prompt = `Analyze this website and determine if it sells products covered by CPS warranty service.

CPS COVERAGE POLICY:
- COVERED: Powered/durable high-ticket goods including electronics, appliances, power tools, firearms, hardware, home improvement items
- EXCLUDED: Apparel/clothing, food/beverages, services, software/digital products, consumables

Website: ${domain}
Title: ${extracted.title}
Description: ${extracted.description}
Product mentions: ${extracted.products.join(', ')}

Classify this website and respond ONLY with valid JSON in this exact format:
{
  "verdict": "Pass" | "Fail" | "Mixed",
  "confidence": number (0-100),
  "category": "string (primary product category)",
  "evidence": ["array of specific evidence phrases from the site"],
  "reason": "string explaining the classification decision"
}

Verdict guidelines:
- Pass: Site primarily sells CPS-covered products
- Fail: Site primarily sells excluded products or doesn't sell physical goods
- Mixed: Site sells both covered and excluded products`;

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You are a classifier that analyzes websites against CPS coverage policy. Always respond with valid JSON only.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('DeepSeek API error response:', errorText);
      throw new Error(`DeepSeek API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Defensive check: ensure response has expected structure
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      console.error('Unexpected DeepSeek API response format:', JSON.stringify(data));
      throw new Error('Invalid AI response format');
    }
    
    const content = data.choices[0].message.content;

    // Parse the JSON response with error handling
    let classification;
    try {
      classification = JSON.parse(content);
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', content);
      throw new Error('AI returned invalid JSON');
    }

    return {
      verdict: classification.verdict || 'Fail',
      confidence: classification.confidence || 50,
      category: classification.category || 'Unknown',
      evidence: classification.evidence || [],
      reason: classification.reason || 'Unable to classify',
    };
  } catch (error) {
    console.error('AI classification error:', error);
    // Fallback heuristic classification
    return fallbackClassification(extracted, domain);
  }
}

function fallbackClassification(extracted, domain) {
  const text = `${extracted.title} ${extracted.description} ${extracted.products.join(' ')}`.toLowerCase();

  // Covered categories
  const coveredKeywords = ['electronic', 'appliance', 'tool', 'hardware', 'firearm', 'gun', 'power tool', 'device', 'gadget', 'equipment', 'machinery'];
  // Excluded categories
  const excludedKeywords = ['cloth', 'apparel', 'fashion', 'food', 'beverage', 'service', 'software', 'digital', 'download', 'subscription'];

  let coveredCount = 0;
  let excludedCount = 0;

  for (const keyword of coveredKeywords) {
    if (text.includes(keyword)) coveredCount++;
  }
  for (const keyword of excludedKeywords) {
    if (text.includes(keyword)) excludedCount++;
  }

  let verdict = 'Fail';
  let confidence = 50;
  let category = 'Unknown';

  if (coveredCount > excludedCount && coveredCount > 0) {
    verdict = 'Pass';
    confidence = Math.min(80, 50 + coveredCount * 10);
    category = 'Covered Products';
  } else if (excludedCount > coveredCount && excludedCount > 0) {
    verdict = 'Fail';
    confidence = Math.min(80, 50 + excludedCount * 10);
    category = 'Excluded Products';
  } else if (coveredCount > 0 || excludedCount > 0) {
    verdict = 'Mixed';
    confidence = 60;
    category = 'Mixed Products';
  }

  return {
    verdict,
    confidence,
    category,
    evidence: [],
    reason: 'Classification based on keyword analysis (AI fallback)',
  };
}
