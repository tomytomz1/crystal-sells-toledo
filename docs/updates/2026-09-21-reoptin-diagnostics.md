# Re-opt-in diagnostics hotfix

Date: 2026-09-21

A controlled Production `/home-value` submission reached the automatic SMS re-opt-in path but the acknowledgement failed closed with `SMS_ACK_REOPTIN_FAILED`.

The failure was safe: the lead was stored, consent evidence was appended, email acknowledgement succeeded, and no SMS was sent. However, the acknowledgement boundary collapsed the re-opt-in result to one coarse token and discarded the already-PII-free diagnostic fields produced by the re-opt-in/provider layers.

This hotfix changes observability only. A failed or blocked re-opt-in still stops before the SMS sender. The returned internal acknowledgement result now carries `websiteSmsReoptinLogShape(...)`, and `leadSmsAckLogShape(...)` copies those safe tokens into the existing `lead.sms_ack` log line.

No phone number, email address, property address, provider exception text, API credential, or message body is added to logs.

Expected Production diagnostic fields on a future failed controlled test may include:

- `website_reoptin_status`
- `website_reoptin_reason`
- `consent_provider_status`
- `consent_provider_reason`

This allows the next controlled test to distinguish configuration, provider access, malformed provider response, partial provider failure, durable-store failure, and projection failure without weakening the send gate or exposing PII.
