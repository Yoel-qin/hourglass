# Synthetic parent skill (baseline asset, revision skill-root-v1)

This is the frozen baseline text for the evolution benchmark. The scripted
adapter treats a `DIRECTIVE-*` marker as "the skill instructs this probe":
the trial runs the matching command and the case passes when its file
assertion holds. The parent covers the four directives below only.

Directive: DIRECTIVE-EVO-FPUB-01 — when asked, run the fpub01 probe.
Directive: DIRECTIVE-EVO-FPUB-02 — when asked, run the fpub02 probe.
Directive: DIRECTIVE-EVO-FHID-01 — when asked, run the fhid01 probe.
Directive: DIRECTIVE-EVO-FHID-02 — when asked, run the fhid02 probe.
