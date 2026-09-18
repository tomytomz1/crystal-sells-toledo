# Twilio Advanced Opt-Out confirmation delivery — closed

**Date:** 18 September 2026  
**Status:** **CLOSED**

Before A2P approval, inbound STOP/START/HELP reached Twilio and the application webhook, but Twilio-generated confirmation messages did not reach the handset.

After Twilio approved campaign `CM3425248ff3928f6f9c78894afe908ae6`, the operator retested all three keywords against the same Messaging Service and confirmed that the Twilio-generated confirmations for **STOP**, **START**, and **HELP** all arrived on the handset.

This closes the prior provider-delivery incident.

The timing strongly suggests the earlier non-delivery was associated with the not-yet-approved campaign/carrier-registration state, but that causal attribution is not proven without Twilio/carrier internal traces.

No application outbound sender was used for these confirmations; `OUTBOUND_SMS_ENABLED` remained off/unset.
