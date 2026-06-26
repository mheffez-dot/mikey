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
        const email = formData.get('email') || 'admin@example.com';

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

        // Send email with results
        await sendEmail(email, results, env);

        return new Response(JSON.stringify({ results }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
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
    // Step 1: Fetch Website - Direct fetch first
    let html = '';
    let statusCode = 0;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });
      statusCode = response.status;
      if (statusCode === 200) {
        html = await response.text();
      }
    } catch (directError) {
      console.log(`Direct fetch failed for ${domain}, trying Bright Data unblocker`);
    }

    // If direct fetch failed or returned non-200, try Bright Data Web Unblocker
    if (!html || statusCode !== 200) {
      try {
        const brightDataUrl = `https://unblocker.brightdata.com/${url}`;
        const response = await fetch(brightDataUrl, {
          headers: {
            'Authorization': `Bearer ${env.BRIGHT_DATA_API_KEY}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });
        if (response.ok) {
          html = await response.text();
        }
      } catch (brightDataError) {
        console.log(`Bright Data fetch also failed for ${domain}`);
      }
    }

    // Step 2: Read & Classify - Extract content
    const extracted = extractContent(html);

    // Use DeepSeek AI to classify
    const classification = await classifyWithAI(extracted, domain, env);

    // Step 3: Return Verdict
    return {
      domain,
      verdict: classification.verdict, // 'Pass', 'Fail', or 'Mixed'
      confidence: classification.confidence, // 0-100
      category: classification.category,
      evidence: classification.evidence,
      reason: classification.reason,
      extracted: {
        title: extracted.title,
        description: extracted.description,
        products: extracted.products.slice(0, 10), // Limit products
      },
    };
  } catch (error) {
    return {
      domain,
      verdict: 'Fail',
      confidence: 100,
      category: 'Unknown',
      evidence: [],
      reason: `Failed to validate: ${error.message}`,
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
      throw new Error(`DeepSeek API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content;

    // Parse the JSON response
    const classification = JSON.parse(content);

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

async function sendEmail(email, results, env) {
  const passCount = results.filter(r => r.verdict === 'Pass').length;
  const failCount = results.filter(r => r.verdict === 'Fail').length;
  const mixedCount = results.filter(r => r.verdict === 'Mixed').length;

  // Build email body with detailed results
  let emailBody = `CPS Vendor Validation Results\n`;
  emailBody += `================================\n\n`;
  emailBody += `Total domains processed: ${results.length}\n`;
  emailBody += `Pass: ${passCount}\n`;
  emailBody += `Fail: ${failCount}\n`;
  emailBody += `Mixed: ${mixedCount}\n\n`;
  emailBody += `Detailed Results:\n`;
  emailBody += `-----------------\n\n`;

  for (const result of results) {
    emailBody += `Domain: ${result.domain}\n`;
    emailBody += `Verdict: ${result.verdict}\n`;
    emailBody += `Confidence: ${result.confidence}%\n`;
    emailBody += `Category: ${result.category}\n`;
    emailBody += `Reason: ${result.reason}\n`;
    if (result.evidence && result.evidence.length > 0) {
      emailBody += `Evidence: ${result.evidence.join(', ')}\n`;
    }
    emailBody += `\n`;
  }

  try {
    // Use Cloudflare Workers Email API or external service
    // For now, using a simple fetch to an email service endpoint
    // In production, configure your preferred email service
    
    if (env.EMAIL_SERVICE_URL) {
      await fetch(env.EMAIL_SERVICE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.EMAIL_API_KEY}`,
        },
        body: JSON.stringify({
          to: email,
          subject: `CPS Vendor Validation Results - ${new Date().toISOString().split('T')[0]}`,
          body: emailBody,
        }),
      });
    } else {
      console.log(`Email would be sent to ${email} with results:`, emailBody);
    }
  } catch (error) {
    console.error('Failed to send email:', error);
  }
}
