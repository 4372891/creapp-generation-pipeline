import Anthropic from '@anthropic-ai/sdk'
import { SiteFacts, SiteType, RECIPES, recipeFor, factsBlock, recipeRulesBlock, SITE_TYPE_LIST } from './recipes'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

// ─── Models ─────────────────────────────────────────────────────
// Heavy HTML generation runs on Sonnet 5 ($2/$10 per MTok intro pricing,
// $3/$15 from Sept 2026 — vs Opus 4.6 at $5/$25 and far shorter outputs).
// Cheap structured JSON steps (styles, plan) run on Haiku 4.5 ($1/$5).
// Both can be overridden via env vars without redeploying code.
const PAGE_MODEL = process.env.ANTHROPIC_PAGE_MODEL || 'claude-sonnet-5'
const CHEAP_MODEL = process.env.ANTHROPIC_CHEAP_MODEL || 'claude-haiku-4-5'

// ─── System Prompts ─────────────────────────────────────────────

const STYLES_PROMPT = `You are a web design consultant. Given a website description: suggest 3 distinct visual style directions, classify the type of site, and extract any concrete business details already present in the description.

Output ONLY valid JSON. No markdown, no backticks, no explanation.

{
  "styles": [
    {
      "name": "Short evocative name (e.g. 'Warm & Rustic', 'Clean Minimal', 'Bold & Modern')",
      "primaryColor": "#hex",
      "secondaryColor": "#hex",
      "accentColor": "#hex",
      "backgroundColor": "#hex (page background, usually light)",
      "fontFamily": "Google Font name",
      "mood": "one word"
    }
  ],
  "siteType": one of ${SITE_TYPE_LIST},
  "prefill": {
    "businessName": "only if explicitly named in the description",
    "email": "only if present",
    "phone": "only if present",
    "address": "city/street only if present",
    "offerings": "menu items / services / products only if listed in the description"
  }
}

Classification guide: "restaurant" = restaurants, cafés, bars, food places; "local-service" = salons, studios, gyms, yoga, clinics, tradespeople, local shops offering services; "portfolio" = photographers, designers, artists showing work; "catalog" = selling physical/digital products; "landing" = startups, apps, products, events; "personal" = an individual's own site, CV, links.

Rules:
- "prefill" keys: include ONLY details explicitly written in the description. Omit any key that is not present. NEVER guess or invent.
- The 3 style options must be clearly different from each other in color, font, and mood.
- Choose well-known Google Fonts that render reliably (Inter, Playfair Display, Space Grotesk, Lora, DM Sans, Merriweather, Poppins, Sora, Cormorant, Outfit, etc.).
- Colors must have good contrast — dark text on light backgrounds.
- Make each option feel like a real brand, not generic.`

const PLAN_PROMPT = `You are a website architect. Given a user's description and a chosen visual style, output a JSON site plan.

Rules:
- Output ONLY valid JSON. No markdown, no backticks, no explanation.
- Keep it minimal and viable: 3-6 pages maximum.
- Every site MUST have an index.html as the homepage.
- Always include essential pages: About and Contact.
- Add specialized pages based on the business type (e.g. Menu for restaurants, Portfolio for creatives, Shop for e-commerce, Services for agencies).
- This is a STATIC website (plain HTML, no backend, no app framework). Every page must be fully functional as static HTML — never plan a feature that needs a server, database, cart, or login.
- If the user asks for a shop / store / e-commerce: plan a CATALOG (lookbook) page — a grid of product cards, each with a real photo, name, short description, and price, and an "Order" action that links to email / WhatsApp / a Stripe Payment Link. Do NOT plan a cart, checkout, or account system — those cannot work on a static site.
- If the user asks for a blog: a static page with 3 sample posts inline — NOT a CMS.
- If the user asks for a newsletter: an email input wired to an external form service (Formspree/Mailchimp link) — NOT a backend.
- If the user asks for booking/appointments: a clear call-to-action linking to email / phone / WhatsApp or an external booking link (e.g. Calendly) — NOT a live scheduling system.
- You will also receive SITE TYPE RULES and VERIFIED BUSINESS FACTS below the description. Obey them strictly: plan only pages consistent with the type rules, never plan anything from the do-not-build list.
- If a business/site name appears in the facts, "siteName" MUST be exactly that name.
- Page "purpose" fields must be grounded in the real facts (the actual dishes/services/products and the actually available contact channels) — do not describe invented content.

Output this exact JSON structure:
{
  "siteName": "Human-readable site name",
  "style": {
    "primaryColor": "#hex",
    "secondaryColor": "#hex",
    "accentColor": "#hex",
    "backgroundColor": "#hex",
    "fontFamily": "Google Font name",
    "mood": "one-word mood"
  },
  "nav": ["Page Name|filename.html", "Page Name|filename.html"],
  "pages": [
    {
      "name": "Page display name",
      "filename": "index.html",
      "purpose": "Detailed description of what this page contains, its sections, and key content"
    }
  ]
}`

const NAV_FOOTER_PROMPT = `You are a world-class web designer. You generate the navigation and footer HTML for a multi-page website. This is a billion dollar company that will be raising funds from VCs. The pages should look bold, futuristic, and clean. These will be reused identically on every page, so they must be page-agnostic — no page-specific content, no active states.

You will receive a description of the business/site. The nav and footer design should MATCH the personality of that business.

Technical rules:
- Output ONLY valid HTML fragments. No markdown, no backticks, no explanation, no <!DOCTYPE>, no <html>, no <head>, no <body>.
- Output exactly TWO sections separated by the marker <!-- FOOTER_SEPARATOR -->
- FIRST section: a complete <header>...</header> block containing the nav
- SECOND section: a complete <footer>...</footer> block
- Use Tailwind CSS classes (loaded via CDN).
- Use the exact colors, font, and mood from the style guide.
- Use relative hrefs (e.g., href="index.html", href="about.html").
- Do NOT mark any link as "active" — that is handled per-page.
- Both components must be responsive.
- Do NOT include <script> tags — the nav and footer must work with pure HTML and CSS (a mobile menu can use a CSS-only pattern or simply show the links).
- The nav and footer must feel like they belong to the same site — consistent in tone, not necessarily identical in structure.`

// Where generated contact forms deliver their submissions. Absolute URL so
// forms keep working from subdomains, /s/ paths, AND downloaded ZIPs.
const FORM_ENDPOINT = `https://${process.env.NEXT_PUBLIC_SITES_DOMAIN || 'creapp.dev'}/api/form-submit`

const PAGE_PROMPT = `You are a great web developer. Generate a COMPLETE, single HTML file for one page of a multi-page static website. This is a billion dollar company that will be raising funds from VCs. The pages should look bold, futuristic, and clean!

You will be given pre-built navigation and footer HTML. You MUST use them exactly as provided.

Rules:
- Output ONLY the raw HTML. No markdown, no backticks, no explanation.
- Always include <!DOCTYPE html> and a full valid HTML structure.
- Use Tailwind CSS via CDN: <script src="https://cdn.tailwindcss.com"></script>
- Import the specified Google Font via <link> in the <head>.
- Use the exact color palette and font from the style guide provided.
- Do NOT include any <base> tag.
- Never output any text before <!DOCTYPE html> or after </html>.
- Keep the page focused: 4-7 strong sections between the nav and footer. Quality over quantity — do not pad the page with repetitive sections.
- Avoid custom <script> blocks. The page must work without JavaScript (Tailwind CDN is the only script allowed).

IMAGES — never fake them:
- Every photo MUST be an <img> element — NEVER a CSS background-image — so owners can replace photos with their own later. (Solid-color/gradient section backgrounds via CSS are fine; photos are not.)
- Do NOT draw SVG shapes, emoji, icon-fonts, or gradient/colored boxes as stand-ins for photos. Those look fake and are impossible for a non-technical user to replace.

COLOR DISCIPLINE:
- Use ONLY the exact hex colors from the style guide (primary, secondary, accent, background) plus neutral grays, white, and black (Tailwind's gray scale is fine). No other hues anywhere — this keeps the site re-themeable.
- Use real photographic <img> tags pointing at a live image service, e.g.:
  <img src="https://picsum.photos/seed/UNIQUE-KEYWORD/800/600" alt="descriptive alt text" class="w-full h-full object-cover" loading="lazy">
- Use a different, memorable seed keyword per image (e.g. seed/leather-boots, seed/salon-interior) so images stay stable across reloads and look distinct.
- Always place images in a fixed-aspect container (e.g. aspect-[4/3] with object-cover) so the layout never shifts.
- SVG is fine ONLY for genuine icons and logos, never for photos/products/people.

ACTIONS must actually work on a plain static site (no backend, no app):
- Buttons/links may ONLY point to: tel: / mailto: / https://wa.me/ built from REAL details in the verified facts, external links provided in the facts (booking, payment, social), another page of this site, an anchor on this page, or the site's form.
- "Order" / "Buy" / "Reserve" actions use a payment or booking link from the facts when one exists; otherwise WhatsApp or email if available; otherwise they link/scroll to the form.
- NEVER output a dead button, or a fake cart / checkout / login / dashboard — nothing that only pretends to work.

REAL DETAILS ONLY:
- The site context includes VERIFIED BUSINESS FACTS. Use those exact details everywhere they belong.
- NEVER invent phone numbers, emails, street addresses, opening hours, prices, or social profiles. If a detail is not in the facts, leave that element out entirely — no placeholders like "(555) 123-4567" or "123 Main Street".
- Social media icons ONLY for profile URLs given in the facts; otherwise no social section at all.

FORMS — every form must actually deliver (critical):
- Any contact / reservation / inquiry / signup / order form MUST use exactly this pattern:
  <form action="${FORM_ENDPOINT}" method="POST">
    <input type="hidden" name="site" value="__CREAPP_SITE_ID__">
    <input type="hidden" name="form_name" value="contact">
    <input type="text" name="company" value="" style="position:absolute;left:-9999px" tabindex="-1" autocomplete="off" aria-hidden="true">
    ...visible fields...
  </form>
- Keep those three inputs EXACTLY as written, including the literal value __CREAPP_SITE_ID__ (it is replaced automatically). The "company" field is a hidden spam trap — never make it visible, never remove it.
- Set form_name to what the form does: "contact", "reservation", "signup", or "order".
- Every visible field needs a name attribute (name, email, phone, message, date, guests, ...) and the form needs a styled submit button.
- NEVER use Formspree, mailto: actions, javascript handlers, or any other endpoint for a form.

NAVIGATION AND FOOTER:
- You will receive pre-built <header> and <footer> HTML.
- Insert the provided header HTML immediately after <body>.
- Insert the provided footer HTML immediately before </body>.
- Do NOT rewrite, restyle, or restructure the nav or footer.`

// ─── Types ──────────────────────────────────────────────────────

export interface StyleOption {
  name: string
  primaryColor: string
  secondaryColor: string
  accentColor: string
  backgroundColor: string
  fontFamily: string
  mood: string
}

export interface SitePlan {
  siteName: string
  style: StyleOption
  nav: string[]
  siteType?: SiteType
  facts?: SiteFacts
  pages: {
    name: string
    filename: string
    purpose: string
  }[]
}

export interface GeneratedPage {
  name: string
  filename: string
  html: string
}

/** Thrown when the model could not produce a complete page within the
 *  continuation rounds / time budget. Routes catch this, refund credits,
 *  and return a retryable error — a truncated page is NEVER returned. */
export class GenerationIncompleteError extends Error {
  constructor(detail: string) {
    super(`generation_incomplete: ${detail}`)
    this.name = 'GenerationIncompleteError'
  }
}

// ─── Truncation-proof generation ────────────────────────────────
// Streams each request (no long non-streaming HTTP calls that risk being
// dropped), detects real truncation via stop_reason === 'max_tokens', then
// continues the SAME assistant turn (prefill continuation) so the model
// resumes exactly where it stopped — no re-emitting, no seams — looping
// until the model finishes, we run out of rounds, or we hit the time budget.

interface GenResult {
  text: string
  complete: boolean
}

type SystemParam = string | Anthropic.TextBlockParam[]

async function generateComplete(opts: {
  model: string
  system: SystemParam
  userContent: string
  maxTokens: number
  maxRounds?: number
  /** Epoch ms after which no NEW continuation round may start.
   *  Keeps us safely inside Vercel's function duration limit. */
  deadline?: number
}): Promise<GenResult> {
  const { model, system, userContent, maxTokens, deadline } = opts
  const maxRounds = opts.maxRounds ?? 3

  const originalUser: Anthropic.MessageParam = { role: 'user', content: userContent }
  let full = ''

  for (let round = 0; round <= maxRounds; round++) {
    // Don't start a round we may not have time to finish.
    if (deadline && Date.now() > deadline - 15_000 && full) {
      break
    }

    const messages: Anthropic.MessageParam[] = [originalUser]
    // On continuation rounds, prefill the assistant turn with everything so
    // far. The API resumes that same turn instead of starting over.
    if (full) {
      // Assistant prefill must not end in trailing whitespace.
      messages.push({ role: 'assistant', content: full.replace(/\s+$/, '') })
    }

    const stream = anthropic.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      messages,
    })
    const res = await stream.finalMessage()

    const chunk = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')

    // Re-anchor `full` to the trimmed prefill we actually sent, then append.
    if (full) full = full.replace(/\s+$/, '')
    full += chunk

    if (res.stop_reason !== 'max_tokens') {
      return { text: full, complete: true }
    }
    // else: hit the cap — loop and continue the same turn.
  }

  // Still truncated after maxRounds / out of time — flag incomplete.
  // Callers must NEVER ship this as a finished page.
  return { text: full, complete: false }
}

// ─── Completeness validation ────────────────────────────────────

function isCompletePage(html: string, requireFooter: boolean): string | null {
  if (!/<!DOCTYPE html/i.test(html)) return 'missing doctype'
  if (!/<\/html>\s*$/i.test(html.trim())) return 'missing closing </html>'
  if (!/<\/body>/i.test(html)) return 'missing closing </body>'
  if (requireFooter && !/<footer[\s>]/i.test(html)) return 'missing footer'
  return null
}

// ─── Step 0: Generate 3 style options ───────────────────────────

export interface StylesResult {
  styles: StyleOption[]
  siteType: SiteType
  prefill: Partial<SiteFacts>
}

const FALLBACK_STYLES: StyleOption[] = [
  { name: 'Clean Modern', primaryColor: '#2563eb', secondaryColor: '#1e40af', accentColor: '#f59e0b', backgroundColor: '#ffffff', fontFamily: 'Inter', mood: 'modern' },
  { name: 'Warm Elegant', primaryColor: '#92400e', secondaryColor: '#78350f', accentColor: '#d97706', backgroundColor: '#fffbeb', fontFamily: 'Playfair Display', mood: 'elegant' },
  { name: 'Bold & Playful', primaryColor: '#7c3aed', secondaryColor: '#5b21b6', accentColor: '#ec4899', backgroundColor: '#faf5ff', fontFamily: 'Space Grotesk', mood: 'playful' },
]

export async function generateStyles(userPrompt: string): Promise<StylesResult> {
  const { text } = await generateComplete({
    model: CHEAP_MODEL,
    system: STYLES_PROMPT,
    userContent: userPrompt,
    maxTokens: 2500,
  })

  const cleaned = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim()

  try {
    const parsed = JSON.parse(cleaned)
    const siteType: SiteType =
      typeof parsed.siteType === 'string' && parsed.siteType in RECIPES ? (parsed.siteType as SiteType) : 'landing'
    const prefill: Partial<SiteFacts> =
      parsed.prefill && typeof parsed.prefill === 'object' ? (parsed.prefill as Partial<SiteFacts>) : {}
    const styles =
      Array.isArray(parsed.styles) && parsed.styles.length > 0 ? (parsed.styles as StyleOption[]) : FALLBACK_STYLES
    return { styles, siteType, prefill }
  } catch {
    return { styles: FALLBACK_STYLES, siteType: 'landing', prefill: {} }
  }
}

// ─── Step 1: Plan the site ──────────────────────────────────────

export async function planSite(
  userPrompt: string,
  chosenStyle?: StyleOption,
  siteType?: SiteType,
  facts?: SiteFacts,
  pageSelection?: { singlePage: boolean; pages: { name: string; filename: string }[] }
): Promise<SitePlan> {
  const styleContext = chosenStyle
    ? `\n\nThe user has chosen this visual style — use these exact values:\n- Primary: ${chosenStyle.primaryColor}\n- Secondary: ${chosenStyle.secondaryColor}\n- Accent: ${chosenStyle.accentColor}\n- Background: ${chosenStyle.backgroundColor}\n- Font: ${chosenStyle.fontFamily}\n- Mood: ${chosenStyle.mood}`
    : ''

  const pagesConstraint = pageSelection
    ? pageSelection.singlePage
      ? `\n\nPAGE SELECTION (mandatory): plan EXACTLY ONE page — index.html — containing everything as sections of a single scrolling page (hero, ${recipeFor(siteType).offeringsLabel.toLowerCase()}, about, contact with the form). The nav links point to #anchors on the same page (e.g. "Menu|index.html#menu").`
      : `\n\nPAGE SELECTION (mandatory): plan EXACTLY these pages and no others:\n- Home (index.html)\n${pageSelection.pages.map((p) => `- ${p.name} (${p.filename})`).join('\n')}`
    : ''

  const guidance = `\n\n${recipeRulesBlock(siteType)}\n${recipeFor(siteType).planGuidance}${pagesConstraint}\n\n${factsBlock(facts)}`

  const { text } = await generateComplete({
    model: CHEAP_MODEL,
    system: PLAN_PROMPT,
    userContent: userPrompt + styleContext + guidance,
    maxTokens: 3000,
  })

  const cleaned = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim()

  try {
    const parsed = JSON.parse(cleaned) as SitePlan
    // Server-side clamp: never build pages beyond what was selected.
    if (pageSelection) {
      if (pageSelection.singlePage) {
        const first = parsed.pages.find((p) => p.filename === 'index.html') || parsed.pages[0]
        parsed.pages = [{ ...first, filename: 'index.html' }]
      } else {
        const allowed = new Set(['index.html', ...pageSelection.pages.map((p) => p.filename)])
        parsed.pages = parsed.pages.filter((p) => allowed.has(p.filename))
        if (!parsed.pages.some((p) => p.filename === 'index.html')) {
          parsed.pages.unshift({ name: 'Home', filename: 'index.html', purpose: userPrompt })
        }
        parsed.nav = (parsed.nav || []).filter((n) => allowed.has((n.split('|')[1] || '').split('#')[0]))
      }
    }
    return { ...parsed, siteType: siteType || 'landing', facts: facts || {} }
  } catch {
    return {
      siteName: facts?.businessName || 'My Website',
      style: chosenStyle || { name: 'Default', primaryColor: '#2563eb', secondaryColor: '#1e40af', accentColor: '#f59e0b', backgroundColor: '#ffffff', fontFamily: 'Inter', mood: 'modern' },
      nav: ['Home|index.html'],
      siteType: siteType || 'landing',
      facts: facts || {},
      pages: [{ name: 'Home', filename: 'index.html', purpose: userPrompt }],
    }
  }
}

// ─── Shared per-site context (cached across the pages of one site) ──
// The style guide + nav + footer are identical for every page of a site,
// so they live in a cache-marked system block: pages 2..N of a build read
// them from the prompt cache at ~10% of the normal input price.

function siteContextBlock(plan: SitePlan, navHtml: string, footerHtml: string): string {
  const style = plan.style
  return `SITE: "${plan.siteName}"

STYLE GUIDE:
- Primary: ${style.primaryColor}
- Secondary: ${style.secondaryColor}
- Accent: ${style.accentColor}
- Background: ${style.backgroundColor}
- Font: ${style.fontFamily}
- Mood: ${style.mood}

NAVIGATION LINKS:
${plan.nav.map((n) => { const [name, file] = n.split('|'); return `- ${name} → href="${file}"` }).join('\n')}

PRE-BUILT NAVIGATION — insert this right after <body> (add active styling to the current page's link):
${navHtml}

PRE-BUILT FOOTER — insert this right before </body>, do not modify:
${footerHtml}

${factsBlock(plan.facts)}

${recipeRulesBlock(plan.siteType)}`
}

// ─── Step 1.5: Generate nav + footer ────────────────────────────

export async function generateNavFooter(
  plan: SitePlan,
  userPrompt?: string,
  deadline?: number
): Promise<{ navHtml: string; footerHtml: string }> {
  const style = plan.style

  const prompt = `Generate the navigation bar and footer for "${plan.siteName}".

WHAT THIS SITE IS:
${userPrompt || plan.siteName}

PAGES ON THIS SITE:
${plan.pages.map((p) => `- ${p.name} (${p.filename}): ${p.purpose}`).join('\n')}

STYLE GUIDE:
- Primary: ${style.primaryColor}
- Secondary: ${style.secondaryColor}
- Accent: ${style.accentColor}
- Background: ${style.backgroundColor}
- Font: ${style.fontFamily}
- Mood: ${style.mood}

NAVIGATION LINKS:
${plan.nav.map((n) => { const [name, file] = n.split('|'); return `- ${name} → href="${file}"` }).join('\n')}

${factsBlock(plan.facts)}

FOOTER CONTENT:
- Site name: ${plan.siteName}
- Copyright: © ${new Date().getFullYear()} ${plan.siteName}
- Include nav links in the footer as well
- Contact details in the footer: ONLY those in the verified facts above (address, phone, email) — omit anything not provided
- Social links: ONLY profiles listed in the facts; otherwise no social icons at all

Choose a nav layout and footer layout that fits the personality of this specific business. Do NOT default to a generic "logo left, links right" bar unless that truly is the best fit.

Generate the header/nav and footer HTML now, separated by <!-- FOOTER_SEPARATOR -->`

  const { text, complete } = await generateComplete({
    model: PAGE_MODEL,
    system: NAV_FOOTER_PROMPT,
    userContent: prompt,
    maxTokens: 6000,
    deadline,
  })

  const cleaned = text.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim()

  const parts = cleaned.split('<!-- FOOTER_SEPARATOR -->')

  if (complete && parts.length >= 2 && /<footer[\s>]/i.test(parts[1])) {
    return {
      navHtml: parts[0].trim(),
      footerHtml: parts[1].trim(),
    }
  }

  // Fallback: try to extract from the output
  const navMatch = cleaned.match(/<(?:header|nav)[\s\S]*?<\/(?:header|nav)>/i)
  const footerMatch = cleaned.match(/<footer[\s\S]*?<\/footer>/i)

  if (!navMatch || !footerMatch) {
    throw new GenerationIncompleteError('nav/footer generation did not produce both components')
  }

  return {
    navHtml: navMatch[0],
    footerHtml: footerMatch[0],
  }
}

// ─── Step 2: Generate one page ──────────────────────────────────

export async function generatePage(
  plan: SitePlan,
  pageIndex: number,
  navHtml: string,
  footerHtml: string,
  deadline?: number
): Promise<string> {
  const page = plan.pages[pageIndex]

  // Static instructions + per-site context are cache-marked system blocks;
  // only the small per-page part below changes between the calls of a build.
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: PAGE_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: siteContextBlock(plan, navHtml, footerHtml), cache_control: { type: 'ephemeral' } },
  ]

  const prompt = `Generate the "${page.name}" page (${page.filename}) for "${plan.siteName}".

CURRENT PAGE: ${page.name} (${page.filename}) — add active styling to this link in the provided nav.

PAGE CONTENT:
${page.purpose}

Generate the COMPLETE HTML file from <!DOCTYPE html> to </html>.
The page body content goes BETWEEN the provided nav and footer.
Do NOT create your own nav or footer — use the ones provided in the site context.`

  const { text, complete } = await generateComplete({
    model: PAGE_MODEL,
    system,
    userContent: prompt,
    maxTokens: 24000,
    maxRounds: 3,
    deadline,
  })

  const html = extractHtml(text)

  const problem = isCompletePage(html, true)
  if (!complete || problem) {
    // NEVER return a truncated page. The route refunds credits and the
    // frontend retries — shipping a visibly cut-off page is not an option.
    throw new GenerationIncompleteError(problem || 'stopped at max_tokens after all continuation rounds')
  }

  return html
}

// ─── Clean response: strip any reasoning text before <!DOCTYPE ──

function extractHtml(raw: string): string {
  let text = raw.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim()
  // Strip any reasoning/thinking text before the actual HTML
  const doctypeIndex = text.indexOf('<!DOCTYPE')
  if (doctypeIndex === -1) {
    const htmlIndex = text.indexOf('<html')
    if (htmlIndex > 0) text = text.slice(htmlIndex)
  } else if (doctypeIndex > 0) {
    text = text.slice(doctypeIndex)
  }
  // Strip anything after the closing </html> tag
  const endIndex = text.toLowerCase().lastIndexOf('</html>')
  if (endIndex !== -1) text = text.slice(0, endIndex + '</html>'.length)
  return text.trim()
}

// ─── Edit a single page ────────────────────────────────────────

export async function editPage(
  currentHtml: string,
  userRequest: string,
  plan?: SitePlan,
  deadline?: number
): Promise<string> {
  const navContext = plan
    ? `\nThis page is part of a multi-page site. If the user is asking to change the navigation or footer, apply those changes — the updated nav/footer will be automatically propagated to all other pages. Always keep the navigation inside a <header>...</header> tag and the footer inside a <footer>...</footer> tag so they can be extracted. Do not split the nav across multiple top-level elements. If the user is NOT asking about the nav or footer, keep them exactly as they are.`
    : ''

  const rulesContext = plan
    ? `\n\n${factsBlock(plan.facts)}\n\n${recipeRulesBlock(plan.siteType)}\nIf the user asks for something in the do-not-build list, implement the closest WORKING alternative from the allowed actions — never a non-functional imitation.\nForms: keep every existing form's action URL and hidden "site" input exactly as they are. Any NEW form must follow the Creapp pattern: action="${FORM_ENDPOINT}" method="POST" with <input type="hidden" name="site" value="__CREAPP_SITE_ID__">, a hidden form_name input, and the off-screen "company" spam-trap input.`
    : ''

  const { text, complete } = await generateComplete({
    model: PAGE_MODEL,
    system: PAGE_PROMPT,
    userContent: `Here is the current HTML:\n\n\`\`\`html\n${currentHtml}\n\`\`\`\n\nApply these changes and respond with the COMPLETE updated HTML. Output ONLY the HTML, no explanations.${navContext}${rulesContext}\n\nChanges requested: ${userRequest}`,
    maxTokens: 24000,
    maxRounds: 3,
    deadline,
  })

  const html = extractHtml(text)

  // Legacy pages generated by older versions may not have a footer —
  // only require one if the page being edited already had one.
  const requireFooter = /<footer[\s>]/i.test(currentHtml)
  const problem = isCompletePage(html, requireFooter)
  if (!complete || problem) {
    throw new GenerationIncompleteError(problem || 'edit stopped at max_tokens after all continuation rounds')
  }

  return html
}
