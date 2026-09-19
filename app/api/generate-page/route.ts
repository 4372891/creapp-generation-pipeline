import { NextRequest, NextResponse } from 'next/server'
import { generatePage, GenerationIncompleteError } from '@/lib/claude'
import { getAuthedUser, deductCredits, refundCredits, supabaseAdmin } from '@/lib/serverAuth'
import { replaceNavFooterInHtml } from '@/lib/navFooter'

// Vercel Hobby + Fluid Compute allows up to 300s. We stop generating at
// ~240s ourselves so we always return a clean, retryable error instead of
// being killed mid-flight with a 504.
export const maxDuration = 300
const TIME_BUDGET_MS = 240_000

const CREDIT_COST = 100

export async function POST(req: NextRequest) {
  const deadline = Date.now() + TIME_BUDGET_MS

  try {
    const user = await getAuthedUser(req)
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    const { plan, pageIndex, navHtml, footerHtml, projectId } = await req.json()

    if (!plan || pageIndex === undefined || !navHtml || !footerHtml || !projectId) {
      return NextResponse.json({ error: 'Missing plan, pageIndex, navHtml, footerHtml, or projectId' }, { status: 400 })
    }

    // The generated page embeds this project's form id — the caller must own it.
    const { data: proj } = await supabaseAdmin.from('projects').select('user_id').eq('id', projectId).single()
    if (!proj || (proj.user_id !== user.id && !user.isAdmin)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    // Admin bypasses credits
    let charged = false
    if (!user.isAdmin) {
      const remaining = await deductCredits(user.id, CREDIT_COST)
      if (remaining === null) {
        return NextResponse.json({ error: 'insufficient_credits' }, { status: 402 })
      }
      charged = true
    }

    try {
      const raw = await generatePage(plan, pageIndex, navHtml, footerHtml, deadline)
      // Wire the page's forms to THIS site's inbox.
      const wired = raw.split('__CREAPP_SITE_ID__').join(String(projectId))
      // Same canonical nav/footer enforcement the client applies, so what we
      // persist is byte-identical to what the browser will render.
      const finalHtml = replaceNavFooterInHtml(wired, navHtml, footerHtml, '', '')

      // ── Persist immediately, before returning ──
      // The browser used to be responsible for saving the page after it
      // arrived. That left a window between "page on screen" and "page in the
      // database": scrolling (which triggers a mobile-Safari fetch bug) or
      // closing the tab during it destroyed a page the user had already paid
      // for. The server generated it and charged for it, so the server saves
      // it — by the time the client has the HTML, it is already stored and
      // no user action can lose it.
      await persistPage(projectId, plan, pageIndex, finalHtml, navHtml, footerHtml)

      return NextResponse.json({ html: finalHtml })
    } catch (genError) {
      // The user must never pay for a page they did not receive.
      if (charged) await refundCredits(user.id, CREDIT_COST)

      if (genError instanceof GenerationIncompleteError) {
        console.error('Generate page incomplete:', genError.message)
        return NextResponse.json(
          { error: 'generation_incomplete', retryable: true },
          { status: 500 }
        )
      }
      throw genError
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('Generate page error:', msg)
    return NextResponse.json({ error: msg, retryable: true }, { status: 500 })
  }
}

/** Merge one freshly generated page into the project's saved site.
 *
 *  Never throws: the user already has their page, and a failed write here is
 *  recoverable by the client's own save. It is logged so failures are visible.
 */
async function persistPage(
  projectId: string,
  plan: { pages: { name: string; filename: string }[] },
  pageIndex: number,
  html: string,
  navHtml: string,
  footerHtml: string
): Promise<void> {
  try {
    const meta = plan?.pages?.[pageIndex]
    if (!meta) return

    const { data: existing } = await supabaseAdmin
      .from('projects')
      .select('html')
      .eq('id', projectId)
      .single()

    let saved: {
      pages?: { name: string; filename: string; html: string }[]
      offeredStyles?: unknown
      buildPhase?: string
    } = {}
    try {
      if (existing?.html) saved = JSON.parse(existing.html)
    } catch {
      saved = {}   // legacy or corrupt payload — start a fresh structure
    }

    const pages = Array.isArray(saved.pages) ? [...saved.pages] : []
    const entry = { name: meta.name, filename: meta.filename, html }
    const at = pages.findIndex(p => p.filename === meta.filename)
    if (at >= 0) pages[at] = entry
    else pages.push(entry)

    const { error } = await supabaseAdmin
      .from('projects')
      .update({
        html: JSON.stringify({
          pages,
          plan,
          navHtml,
          footerHtml,
          // Preserve whatever the client last set; do not clobber build state.
          offeredStyles: saved.offeredStyles,
          buildPhase: saved.buildPhase || 'reviewing',
        }),
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)

    if (error) console.error('persistPage update failed:', error.message)
  } catch (e) {
    console.error('persistPage threw:', e instanceof Error ? e.message : String(e))
  }
}
