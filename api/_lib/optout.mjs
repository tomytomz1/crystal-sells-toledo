/* Deterministic opt-out classification for inbound consumer messages.
 *
 * Gate 7 design: docs/updates/2026-09-10-stop-dnc-suppression-decision.md §2.5.
 *
 * Pure. No I/O, no network, no clock, no randomness. Given the same text it
 * returns the same answer forever, which is the property that lets a
 * compliance conversation cite it.
 *
 * ---------------------------------------------------------------------
 * TWO THINGS ARE RULED OUT, AND THE REASONS ARE THE DESIGN
 * ---------------------------------------------------------------------
 *
 * NO AI CLASSIFIER. It would add a network dependency, a latency budget
 * and a failure mode to a path whose whole job is to be reliable, and its
 * errors cannot be explained after the fact. A rule list can be read,
 * reviewed, tested and cited. That matters more here than accuracy at the
 * margin.
 *
 * NO SUBSTRING MATCHING. `body.includes("stop")` classifies "stop by the
 * open house on Sunday" as an opt-out. That is not a conservative failure:
 * it silently destroys a live lead AND records a legal state the consumer
 * never asked for. Every rule below binds a verb of stopping to an OBJECT
 * OF CONTACTING, anchored at word boundaries.
 *
 * ---------------------------------------------------------------------
 * THE BIAS
 * ---------------------------------------------------------------------
 * A false positive costs one lead, visibly, and a human can undo it. A
 * false negative means continuing to message someone who asked us to stop.
 * So where intent to stop is clear, suppress. Where it is not clear,
 * classify nothing and let a human read it — `classifyInbound()` returning
 * null is not "ignore this", it is "a person should see this".
 */

import { CHANNEL, EVENT_TYPE } from "./consent-ledger.mjs";
import { SUPPRESSION_REASON } from "./consent.mjs";
import { SUPPRESSION_SCOPE } from "./permission.mjs";

/**
 * Fold a message to its comparable form.
 *
 * Punctuation becomes a space rather than nothing, so "stop.texting" and
 * "stop texting" agree and "stopwatch" is never manufactured out of two
 * separate words.
 */
export function normalise(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .normalize("NFKC")
    /* Apostrophes are removed rather than spaced: "don't" -> "dont", which
       is what the patterns below expect and what lets one rule cover the
       curly and straight forms together. */
    .replace(/['‘’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* ---------------------------------------------------------------------
   THE KEYWORDS
   ---------------------------------------------------------------------
   Matched as the WHOLE normalised message, never as a fragment. Twilio
   already acts on these itself; we match them for the case where
   Advanced Opt-Out is not enabled and no OptOutType arrives.
   --------------------------------------------------------------------- */
/* Twilio's default English long-code opt-out list, in full:
     STOP  UNSUBSCRIBE  END  QUIT  STOPALL  REVOKE  OPTOUT  CANCEL
   `REVOKE` was missing until an independent review caught it — a consumer
   who replied REVOKE would have been opted out by Twilio while our own
   fallback layer classified nothing, so the ledger would have held no
   evidence of an opt-out Twilio had already enforced. `opt out` is kept
   as a spaced variant of OPTOUT, which normalisation would otherwise split. */
export const STOP_KEYWORDS = Object.freeze([
  "stop", "unsubscribe", "end", "quit", "stopall", "revoke", "optout", "cancel",
  "opt out",
]);

export const START_KEYWORDS = Object.freeze(["start", "unstop", "yes", "optin", "opt in"]);

export const HELP_KEYWORDS = Object.freeze(["help", "info"]);

/* ---------------------------------------------------------------------
   THE RULES — DATA, NOT LOGIC
   ---------------------------------------------------------------------
   Each entry is reviewable on its own line and has a test. `scope` decides
   which channel is suppressed; a message about calls does not suppress
   texts, and vice versa, because suppressing a permission the consumer did
   not withdraw destroys it.

   `\b` on both ends throughout. The objects of contacting are the load
   bearing half: without them "stop" is just a word.
   --------------------------------------------------------------------- */
const CONTACT_OBJECT = "(?:text|texts|texting|message|messages|messaging|sms|email|emails|emailing)";
const CALL_OBJECT = "(?:call|calls|calling|phone|phoning)";
const ANY_OBJECT = `(?:${CONTACT_OBJECT}|${CALL_OBJECT}|contact|contacting)`;

export const OPT_OUT_RULES = Object.freeze([
  /* --- SMS / messaging --------------------------------------------- */
  {
    id: "stop_verb_message_object",
    scope: SUPPRESSION_SCOPE.SMS,
    pattern: new RegExp(`\\b(?:stop|quit|cease|halt)\\s+(?:\\w+\\s+){0,2}?${CONTACT_OBJECT}\\b`),
  },
  {
    id: "no_more_messages",
    scope: SUPPRESSION_SCOPE.SMS,
    pattern: new RegExp(`\\bno\\s+more\\s+(?:\\w+\\s+){0,2}?${CONTACT_OBJECT}\\b`),
  },
  {
    id: "do_not_message_me",
    scope: SUPPRESSION_SCOPE.SMS,
    pattern: new RegExp(`\\b(?:do\\s+not|dont|never)\\s+${CONTACT_OBJECT}\\s+me\\b`),
  },

  /* --- Voice -------------------------------------------------------- */
  {
    id: "stop_verb_call_object",
    scope: SUPPRESSION_SCOPE.VOICE,
    pattern: new RegExp(`\\b(?:stop|quit|cease|halt)\\s+(?:\\w+\\s+){0,2}?${CALL_OBJECT}\\b`),
  },
  {
    id: "do_not_call_me",
    scope: SUPPRESSION_SCOPE.VOICE,
    pattern: new RegExp(`\\b(?:do\\s+not|dont|never)\\s+${CALL_OBJECT}\\s+me\\b`),
  },
  {
    id: "no_more_calls",
    scope: SUPPRESSION_SCOPE.VOICE,
    pattern: new RegExp(`\\bno\\s+more\\s+(?:\\w+\\s+){0,2}?${CALL_OBJECT}\\b`),
  },

  /* --- All channels -------------------------------------------------
     Reserved for an UNAMBIGUOUS all-channel request. A channel-specific
     STOP does not escalate to global — it says what it says. */
  {
    id: "remove_me_from_list",
    scope: SUPPRESSION_SCOPE.GLOBAL,
    pattern: /\b(?:remove|delete|take)\s+me\s+(?:\w+\s+){0,2}?(?:off|from)\s+(?:your|the|this)\s+(?:list|database|records|system)\b/,
  },
  {
    id: "stop_contacting_me",
    scope: SUPPRESSION_SCOPE.GLOBAL,
    pattern: /\b(?:stop|quit|cease)\s+(?:\w+\s+){0,2}?contacting\s+me\b/,
  },
  {
    id: "do_not_contact_me",
    scope: SUPPRESSION_SCOPE.GLOBAL,
    pattern: /\b(?:do\s+not|dont|never)\s+contact\s+me\b/,
  },
  {
    id: "not_interested_plus_stop",
    scope: SUPPRESSION_SCOPE.GLOBAL,
    /* "not interested" ALONE is a sales answer, not an opt-out, and must
       not suppress. It counts only alongside an explicit stop clause. */
    pattern: new RegExp(`\\bnot\\s+interested\\b(?=.*\\b(?:stop|remove\\s+me|do\\s+not|dont|never)\\s+(?:\\w+\\s+){0,2}?${ANY_OBJECT}\\b)`),
  },
]);

/* Scope -> the LEDGER reason. Not HubSpot's vocabulary: that mapping lives
   in api/_lib/hubspot-consent-state.mjs, is keyed by trigger rather than by
   scope, and is deliberately left alone. These are the internal event
   classifications, and the two vocabularies are not the same list. */
const REASON_BY_SCOPE = Object.freeze({
  [SUPPRESSION_SCOPE.SMS]: SUPPRESSION_REASON.STOP_KEYWORD,
  [SUPPRESSION_SCOPE.VOICE]: SUPPRESSION_REASON.VOICE_DNC,
  [SUPPRESSION_SCOPE.GLOBAL]: SUPPRESSION_REASON.GLOBAL_DNC,
});

/* Scope -> the channel written to the ledger. */
const SCOPE_TO_CHANNEL = Object.freeze({
  [SUPPRESSION_SCOPE.SMS]: CHANNEL.SMS,
  [SUPPRESSION_SCOPE.VOICE]: CHANNEL.AI_VOICE,
  [SUPPRESSION_SCOPE.GLOBAL]: CHANNEL.ALL,
});

/**
 * Classify one inbound message.
 *
 * Returns `null` when nothing matched — which means "a human should read
 * this", not "discard it". The caller surfaces it.
 *
 * Otherwise `{ kind, scope, channel, eventType, reasonCode, rule }`:
 *
 *   kind `suppress`  — a suppression must be recorded
 *   kind `reoptin`   — they asked to come back; NOT a grant (§2.4)
 *   kind `help`      — informational; no ledger event at all (§2.4)
 */
export function classifyInbound(body) {
  const text = normalise(body);
  if (!text) return null;

  /* 1. Whole-message keywords, in the order the design states. */
  if (HELP_KEYWORDS.includes(text))
    return { kind: "help", rule: "keyword_help" };

  if (STOP_KEYWORDS.includes(text)) {
    return {
      kind: "suppress",
      scope: SUPPRESSION_SCOPE.SMS,
      channel: CHANNEL.SMS,
      eventType: EVENT_TYPE.SUPPRESSED,
      reasonCode: SUPPRESSION_REASON.STOP_KEYWORD,
      rule: "keyword_stop",
    };
  }

  if (START_KEYWORDS.includes(text)) {
    return {
      kind: "reoptin",
      scope: SUPPRESSION_SCOPE.SMS,
      channel: CHANNEL.SMS,
      eventType: EVENT_TYPE.REOPTIN_REQUESTED,
      reasonCode: null,
      rule: "keyword_start",
    };
  }

  /* 2. Intent-bearing phrases. First match wins; the list is ordered
        channel-specific before global so that "stop texting me" suppresses
        SMS rather than everything. */
  for (const rule of OPT_OUT_RULES) {
    if (!rule.pattern.test(text)) continue;
    return {
      kind: "suppress",
      scope: rule.scope,
      channel: SCOPE_TO_CHANNEL[rule.scope],
      /* `revoked`, not `suppressed`: the consumer withdrew in words rather
         than through a keyword or a carrier action, and recording the two
         identically would lose the reason a future reader needs. */
      eventType: EVENT_TYPE.REVOKED,
      /* One reason per scope, and all three are distinct. An all-channel
         request is GLOBAL_DNC, not a keyword stop: "stop contacting me"
         is not the STOP keyword, and recording it as one would make the
         ledger describe the wrong act in the row that exists to describe
         the act. Caught in review — this branch was two-way and silently
         labelled every global request `stop_keyword`. */
      reasonCode: REASON_BY_SCOPE[rule.scope],
      rule: rule.id,
    };
  }

  /* 3. Not an opt-out. A person should see it. */
  return null;
}

/** A PII-free line for logs: the decision, never the message. */
export function classificationLogShape(result) {
  if (!result) return { classified: false };
  return {
    classified: true,
    kind: result.kind,
    rule: result.rule,
    ...(result.channel ? { channel: result.channel } : {}),
  };
}
