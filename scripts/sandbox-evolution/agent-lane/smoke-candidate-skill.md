---
name: hourglass-agent-lane-smoke
description: Agent-lane smoke candidate skill carrying HOURGLASS_AGENT_SKILL_MARKER_51c7 through the content-addressed snapshot.
---

# Agent-lane smoke candidate skill

This is the committed candidate skill for the agent-lane MOCK smoke run. Its
body carries the marker HOURGLASS_AGENT_SKILL_MARKER_51c7 so the runner can
prove (P4-style) that the content-addressed candidate snapshot reached the
child's model request. In the mock lane the "model" is the scripted mock
server, so the skill's behavioral effect is zero by construction — the smoke
lane validates the pipeline (carrier, confinement, hidden judge, metering),
never a scored benchmark result.

When asked to repair a workspace defect: apply the required change to the
named file inside the workspace, keep every other file untouched, and finish
with a short confirmation.
