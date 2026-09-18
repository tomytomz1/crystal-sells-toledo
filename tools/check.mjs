/* Composite repository checker.
 *
 * check-base.mjs is the exact checker from current main, preserving all later
 * Turnstile and operator-unsuppression guards. check-sms-sender.mjs adds PR
 * #51's Gate 8/outbound-sender invariants without replacing those guards.
 */
await import("./check-base.mjs");
await import("./check-sms-sender.mjs");
