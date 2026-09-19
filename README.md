# Creapp — generation pipeline

Two files from the private codebase behind [creapp.dev](https://creapp.dev), a live SaaS where
a chat description becomes a complete multi-page website. This is the part that turns a prompt
into pages.

It won't run on its own. `lib/claude.ts` imports a `recipes` module holding the per-industry
rules, and the route depends on the app's auth and billing helpers. It's here to be read, not
cloned.

## What it does

A build runs in four steps, each its own model call:

1. **Styles** — three visual directions for the user to choose from, returned as JSON.
2. **Plan** — pages, filenames and shared navigation, returned as JSON.
3. **Nav and footer** — generated once, then reused byte-identically on every page.
4. **Pages** — one call per page, with the plan, the style guide and the shared nav passed
   back in as context, so pages stay coherent instead of each being produced blind.

The backend drives the loop. The model doesn't choose the order.

## The problem this solves

Pages were arriving truncated — HTML that just stopped, with no closing tags.

The obvious fix is to raise `max_tokens`. That didn't work, because a higher cap only moves
where the cut happens. What matters is knowing whether the model finished, and being able to
carry on when it didn't.

`generateComplete()` in `lib/claude.ts` does three things:

- **Streams every request**, so there's no long non-streaming HTTP call left to be dropped.
- **Checks `stop_reason === 'max_tokens'`**, which separates real truncation from a model that
  simply finished early.
- **Continues the same assistant turn.** Everything generated so far is sent back as an
  assistant prefill, so the model resumes from exactly where it stopped rather than starting
  again. Nothing is re-emitted and there's no seam in the middle of the file.

It loops until the model finishes, runs out of rounds, or reaches a deadline set below the
platform's function timeout — so a slow build returns a clean retryable error instead of dying
as a 504 halfway through.

`isCompletePage()` then checks the result is a whole document: doctype, closing `</body>`,
closing `</html>`, footer present.

If it isn't, `GenerationIncompleteError` is thrown, and
`app/api/generate-page/route.ts` refunds the user's credits and returns a retryable error. A
truncated page is never returned and never saved. The rule is that the system either proves it
finished or hands you nothing.

## Cost

A site cost about €0.70 to generate. Three changes brought that down a long way:

- **Different models for different steps.** Heavy HTML generation on Sonnet, the cheap
  structured JSON steps on Haiku. Both model names come from environment variables, so trying
  a new model is a config change rather than a code change.
- **Prompt caching.** The page prompt and the per-site context — style guide, navigation,
  footer, industry rules — are identical for every page of a site, so they're sent as
  cache-marked blocks. Page two onwards reads them from cache.
- **Streaming**, which also removed the dropped-connection failures described above.

## The two files

**`lib/claude.ts`** — system prompts, model routing, the continuation loop, completeness
validation, and the four pipeline steps.

**`app/api/generate-page/route.ts`** — the route that generates one page: ownership check,
credit charge, time budget, refund on failure, and saving the page server-side before
responding. That last part came from a real bug: the browser used to save the page after it
arrived, which left a window where closing the tab lost a page the user had already paid for.
