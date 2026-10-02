# dish-skills

Skills for dish agents, kept in the config store as `skills/<name>/SKILL.md` and offered to each agent through dsh's skill registry, by role.

This package is being built (roadmap step 3a). What is here so far is the skill format: `src/skill.ts` parses and checks a skill document, and makes the `skills/` claim on the config store. The service, the providers, the Settings page and the shipped skills follow.

The design and its reasoning are in the [spec](../../docs/specs/skills.md) and the [plan](../../docs/plans/2026-10-02-skills.md).
