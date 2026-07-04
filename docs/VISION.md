# Plaudern — Feature Vision: from inbox to memory prosthesis

> Goal: a fully automatic, highly integrated AI platform for note-taking,
> documentation, life planning and personal assistance — built for someone
> with a bad memory who is *not* going to take notes manually. Capture must be
> effortless, understanding must be automatic, and recall must be proactive.
>
> This document is a brainstorm/roadmap. Nothing here is implemented; it maps
> ideas onto the existing architecture (append-only inbox, source adapters,
> extraction pipeline, voice profiles/contacts, calendar links).

Everything below follows one architectural rule that already exists in the
codebase and should never be broken: **sources are immutable, intelligence is
append-only.** Every new capability is either (a) a new *source adapter*,
(b) a new *extraction kind* on existing items, or (c) a *derived read model*
built from extractions that can be dropped and regenerated at any time. That
keeps the whole platform reprocessable: when models get better, re-run the
pipeline and the entire memory upgrades itself.

---

## 1. The understanding layer — extractions beyond transcription

Today an audio item gets: transcript → diarization → summary. The biggest
leverage is adding more extraction kinds that run on *every* item, because
every feature in the rest of this document is built from them.

- **Entity extraction** (`kind: entities`): people, organizations, places,
  dates, amounts, products, medications, file/document references. Each entity
  is normalized and linked to a registry (people link to the existing contact
  book — the voice-profile contacts become the seed of a knowledge graph).
- **Commitment extraction** (`kind: commitments`): the killer feature for bad
  memory. Detect *promissory language* in both directions:
  - "I'll send you the draft by Friday" → **you owe** Anna, due Friday.
  - "Tom said he'd check with the landlord" → **Tom owes you**.
  Each commitment carries: who, to whom, what, due date (resolved from
  "Friday" using `occurredAt`), and the source segment timestamp so you can
  jump to the exact moment in the audio.
- **Action items / tasks** (`kind: tasks`): like commitments but self-directed
  ("I need to book the dentist"). Deduplicated semantically against existing
  open tasks so ten mentions of the dentist stay one task with ten citations.
- **Open questions** (`kind: questions`): questions you asked that got no
  answer, and questions asked *of you* that you deferred. These are the loops
  a bad memory drops silently.
- **Decisions** (`kind: decisions`): "we decided to go with the cheaper
  option" — a searchable decision log with context and participants, so you
  never re-litigate a settled question (or can, deliberately, with the
  original reasoning in front of you).
- **Personal facts** (`kind: facts`, scoped to a contact): "my daughter starts
  school in August", "he's allergic to nuts", "her birthday is in March".
  These feed the personal-CRM features below.
- **Embeddings** (`kind: embedding`): chunked vector embeddings of transcript +
  summary (pgvector fits the existing Postgres). Foundation for semantic
  search, dedupe, clustering, and RAG.
- **Topic/project classification** (`kind: topics`): zero-shot tagging against
  a user-editable topic taxonomy that the system also *proposes* extensions to
  ("14 recent items mention 'Hausbau' — create a project?").
- **OCR & document understanding** (`kind: ocr`, `kind: docmeta`): once photos
  and PDFs are sources (see §2), extract text, document type (invoice,
  contract, letter, prescription), key fields (amount, IBAN, due date,
  cancellation deadline, expiry).
- **Translation** (`kind: translation`): you already have per-user summary
  language; extend it so any transcript/summary is available in the user's
  language on demand.

Because these are just more extraction rows, they inherit everything for free:
reprocessing, per-user isolation, the tombstone logic, and the test strategy.

## 2. More ways in — new source adapters

The adapter registry is the extension point. Capture has to meet the user
where life happens, with zero friction:

- **Email-in address** (`sources/email`): every user gets
  `inbox+<token>@your-domain`. Forward anything — confirmations, tickets,
  letters from the Amt — and it becomes an inbox item with attachments as
  payloads. This is the single cheapest high-value adapter: it instantly
  integrates *every* service that can send email.
- **Photo/scan** (`sources/image`): snap paper mail, whiteboards, receipts,
  business cards, handwritten notes. OCR + docmeta extraction turns the
  physical world into searchable memory. Business cards auto-create/enrich
  contacts.
- **Messaging bots** (`sources/telegram`, `sources/whatsapp`): a bot you can
  send voice notes, texts, photos, and forwards to. Crucially it's also an
  *output* channel (§7). For a phone-first life this may beat the web app as
  the daily driver.
- **Web clipper / share target** (`sources/web`): a browser extension and a
  PWA share-target so "share to Plaudern" exists on every page and in every
  mobile app. Stores URL + readable-mode text snapshot (link rot insurance).
- **Meeting bot** (`sources/meetingbot`): joins Zoom/Meet/Teams calls as a
  participant (e.g. via a Recall.ai-style service) so online meetings flow
  into the same transcription→diarization→summary pipeline as Plaud
  recordings — with the calendar link already known at ingest time.
- **Screenshots + screen OCR** (`sources/screenshot`): a desktop hotkey that
  captures, OCRs, and files a screenshot with the active window title.
- **Read-later / highlights** (`sources/highlights`): Kindle/KOReader
  highlights, Readwise import, RSS starred items — what you *read* is part of
  memory too.
- **Location trail** (`sources/location`, opt-in): OwnTracks/Home Assistant
  pings become a private location timeline. Powers "where was I when…",
  auto-context for recordings ("at the doctor's office"), and
  location-triggered reminders (§5).
- **Health & sleep** (`sources/health`, opt-in): Apple Health / Garmin /
  Withings export. Not for fitness — for *context*: "you slept 4h before that
  argument" is memory-relevant.
- **Documents vault** (`sources/document`): PDFs uploaded or emailed in —
  contracts, insurance policies, warranties, IDs — with expiry/cancellation
  dates extracted and turned into reminders (German bureaucracy as a service:
  Kündigungsfristen never missed again).
- **Structured quick-capture** (`sources/quick`): a watch complication /
  widget / hardware-button flow that records 10 seconds with one tap. The
  cheaper the capture, the more the platform learns.

## 3. Derived knowledge — what gets built *on top* of extractions

These are regenerable read models, never the source of truth:

- **Living topic documents.** For each project/topic ("Hausbau", "Job search",
  "Mom's health"), the AI maintains an evergreen Markdown document —
  current state, timeline, decisions, open items, people involved — that
  *updates itself* whenever a related inbox item lands. Each statement cites
  its source items. This is "documentation that writes itself": you never
  edit it, you just live your life and the document stays current. A history
  of document versions shows how a topic evolved.
- **Person pages (personal CRM).** The contact book grows from
  "voice profiles + names" into full dossiers: every conversation with this
  person, extracted facts (kids' names, birthday, allergies, preferences,
  gift ideas they mentioned), commitments open in both directions, last
  contact date, relationship notes. Before you meet someone, this page *is*
  your memory of them.
- **Knowledge graph.** Entities (people, places, orgs, topics, documents,
  events) with typed edges ("discussed at", "promised in", "works at",
  "related to"). Enables graph queries the vector search can't answer:
  "everything connecting the landlord, the contract, and the water damage."
- **The daily journal, written for you.** Every evening the system composes
  the day from all signals — recordings, calendar events, locations, photos,
  messages — into a narrative diary entry with links to sources. You get a
  life journal without ever journaling. Weekly/monthly/yearly rollups
  ("Your June") compose from the dailies.
- **Timeline view.** An infinite, zoomable timeline of your life across all
  sources — the calendar month view generalized. "What was I doing in
  March 2026?" gets a real answer.
- **Unified task ledger.** Tasks/commitments from §1 materialize into an
  actual task system with states (open/done/dropped), *evidence-based
  completion* ("in yesterday's call you said you sent it — mark done?"), and
  optional two-way sync to Todoist/Things/Reminders for people who already
  have a system.

## 4. Recall — ask your memory anything

- **Memory chat (RAG over your life).** A conversational interface over
  everything: "What did the doctor say about the dosage?", "When did I last
  talk to Karsten and what about?", "What's the Wi-Fi password the landlord
  mentioned?" Every answer cites inbox items with **deep links to the audio
  timestamp** — click a citation, hear the actual moment. Citations are
  non-negotiable (see Protective AI, §6): an uncited claim is not an answer.
- **Hybrid search.** Semantic + keyword + structured filters (person, place,
  date range, source type, topic) in one query box, with "more like this" on
  every item.
- **Voice recall.** Ask by voice — from the bot ("Hey, what time is the thing
  on Thursday?"), the watch, or eventually a wake-word device. For bad memory,
  the retrieval interface must be as frictionless as the capture.
- **"Remind me what I know about X" mode:** before walking into any situation,
  one tap produces a one-screen brief from the knowledge graph.
- **MCP server.** Expose the whole memory as an MCP server so Claude (or any
  agent) can use Plaudern as a tool: your notes become usable context in every
  AI conversation you have anywhere. This turns Plaudern from an app into
  *infrastructure for your other AIs* — arguably the most strategic
  integration on this list.

## 5. Proactive memory — the assistant comes to you

A person with a bad memory doesn't know what to search for. The system must
push, not just pull:

- **Pre-meeting briefings.** The calendar link already exists — 30 minutes
  before an event, push a brief: who's attending (matched to contacts), what
  happened last time, open commitments in both directions, open questions,
  relevant living-document excerpts. This alone justifies the platform.
- **Morning briefing / evening review.** Morning: today's events with context,
  commitments due, things to not forget. Evening: the auto-journal draft,
  loose ends detected today, one-tap confirmations ("did you actually book
  the dentist?").
- **Commitment nudges.** "You told Anna you'd send the draft by Friday —
  it's Thursday and no item mentions you did." And the sweeter inverse:
  "Tom promised the landlord's answer two weeks ago — want a nudge text
  drafted?"
- **Open-loop surfacing (the Zeigarnik list).** A standing view of every
  unresolved thread across all conversations, ranked by age and importance.
  Bad memory's biggest failure mode — silently dropped loops — becomes a
  managed queue.
- **Location-triggered recall** (with the opt-in location trail): arrive at
  the hardware store → "3 weeks ago you said you needed hinges." Arrive at
  your parents' → "you wanted to ask Dad about the insurance folder."
- **Prospective-memory events.** Anything with a future date in any source —
  "the results should be in by the 14th", contract expiries, "let's talk
  again next month" — becomes a calendar-visible reminder automatically.
- **Spaced-repetition for what you *want* to remember.** Mark a fact, name,
  or word and the system resurfaces it at expanding intervals inside the
  briefings — a memory prosthesis that also trains the biological one.
- **Relationship drift alerts.** "You haven't spoken with your mother in six
  weeks (usual rhythm: weekly)." Opt-in, gentle, and easily the most humanly
  valuable notification the system can send.
- **"On this day."** Lightweight resurfacing of past moments in the morning
  brief — memory needs rehearsal to feel like yours.

## 6. Protective AI — the guardian layer

The platform hears everything, so it must actively protect its owner —
legally, financially, emotionally, and from *itself*:

- **Consent & recording-law guardian.** This one matters urgently for a
  German user with an always-on recorder: recording confidential speech
  without consent is criminal (§ 201 StGB). Features: per-contact consent
  flags in the contact book; detection of new unknown voices in a recording →
  prompt "does this person know?"; one-tap **redact-this-speaker** (their
  diarized segments are excluded from transcripts/summaries/search while the
  immutable source stays sealed or is deleted whole); configurable auto-delete
  for recordings containing non-consented voices; a "recording disclosure"
  reminder before meetings.
- **Sensitive-content sentinel.** Detect passwords, IBANs, health details,
  other people's secrets in any extraction → auto-classify the item's
  sensitivity, mask by default in summaries/search results, require an extra
  step to reveal, and *exclude from external-LLM calls* (route sensitive items
  to a local model only — see §8).
- **Scam & pressure protection.** For captured calls/conversations: flag
  urgency-pressure patterns, payment-detail changes ("the invoice IBAN
  differs from every previous invoice from this contact"), claims that
  contradict your own records ("caller says the contract renews Monday —
  your stored contract says March"). A bad memory is precisely what social
  engineers exploit; a perfect memory is the antidote.
- **Financial guardian.** Aggregate every money commitment mentioned anywhere
  (subscriptions, "I'll pay you back", verbal quotes from craftsmen) into a
  ledger; flag duplicates, forgotten reimbursements, and quotes that grew
  between the verbal agreement and the invoice.
- **Wellbeing signals (strictly opt-in).** Long-horizon trends only — "your
  conversations with X have been consistently negative for a month", workload
  creep, sleep-vs-mood correlations from the health source. Framed as private
  mirror, never as diagnosis, and never pushed unless enabled.
- **Anti-hallucination discipline.** Structural, not aspirational: every
  generated claim in briefs/answers/living documents must carry a citation to
  a source item + timestamp; a verification pass re-checks high-stakes
  extractions (dates, amounts, names) against the raw transcript; confidence
  is shown, and low-confidence memory says "I think — check the source"
  instead of asserting. A memory prosthesis that confabulates is worse than
  none.
- **Memory integrity.** The inbox is already append-only; add hash-chaining
  over items and extractions so memory is tamper-evident — useful the day a
  recording matters in a dispute, and a strong trust story generally.
- **Data sovereignty.** Per-item sensitivity tiers with different processing
  policies; a per-user **audit log of every byte sent to every external AI
  provider**; export-everything (Markdown + assets + JSON) at any time;
  panic-delete; and a **legacy/emergency access** mechanism (dead-man's
  switch) — a life archive needs an answer for incapacity.

## 7. Surfaces — where you meet it

- **Mobile app** (already planned): capture-first, one-tap record, share
  target, offline queue, push for briefings.
- **Messaging bot as a full duplex channel:** capture in, briefings/answers
  out. Lowest-friction surface that exists; probably beats the app for daily
  use.
- **Watch / widget:** record + "what's next + what do I owe" glance.
- **Email digest** for the weekly review; **browser extension** for clipping
  and "what do I know about this page's topic?".
- **Home Assistant / smart speaker** integration: capture and recall by voice
  at home.
- **Public API + webhooks + MCP** so the platform is scriptable and other
  agents can read/write memory (with the §6 policies enforced at the API
  layer, not per-client).

## 8. Platform & infrastructure to enable all of it

- **pgvector** in the existing Postgres for embeddings; hybrid search =
  pgvector + Postgres FTS. No new database.
- **Extraction-pipeline DAG:** generalize the current "commit → transcribe →
  diarize → summarize" chain into a declarative graph of extractors with
  dependencies, per-kind versioning, and **backfill runs** ("re-run
  `commitments@v3` over all 2026 items") — the mechanism that lets the whole
  memory improve as models improve.
- **Local-model tier:** Whisper + a local LLM (Ollama) as alternative
  providers behind the existing provider abstractions — required by the
  sensitivity routing in §6, nice for cost, and makes the whole platform
  self-hostable without any cloud AI.
- **Per-user provider keys & cost dashboard:** each user brings their own API
  keys; the system tracks spend per extraction kind ("your memory cost €3.20
  this month").
- **Quality evals:** a small labeled set per extraction kind (did it find the
  commitments? the right due date?) run in CI, so pipeline changes are
  measured, not vibed.
- **Notification engine:** one scheduler/delivery abstraction (push, bot,
  email) that all proactive features (§5) share, with per-category quiet
  hours and frequency caps — proactive must never become spammy or it gets
  muted and the mission fails.
- **Obsidian/filesystem mirror (read-only export):** continuously render the
  derived documents into a Markdown vault for people who want their memory in
  plain files they own.

---

## Suggested build order (leverage per effort)

1. **Embeddings + memory chat with citations** (§1, §4) — makes everything
   already captured *retrievable*; the platform starts paying rent
   immediately.
2. **Commitments/tasks/questions extraction + open-loop view** (§1, §3, §5) —
   the core bad-memory pain, built from data already flowing.
3. **Pre-meeting briefings + morning brief** (§5) — proactive value from the
   calendar links that already exist.
4. **Email-in + photo/OCR adapters** (§2) — cheap, huge capture-surface
   expansion beyond audio.
5. **Person pages / facts extraction** (§3) — the contact book becomes a CRM.
6. **Consent guardian + sensitivity routing + local-model tier** (§6, §8) —
   before always-on capture scales up, the protective layer must exist.
7. **Living topic documents + daily auto-journal** (§3) — the
   "documentation platform" promise, delivered.
8. **Messaging bot + MCP server** (§7) — the surfaces that make it ambient.

The through-line: Plaudern's moat is the **append-only, reprocessable,
citation-backed memory substrate**. Features come and go; the substrate —
immutable capture, versioned extractions, derived-and-regenerable knowledge —
is what makes a trustworthy external memory possible at all.
