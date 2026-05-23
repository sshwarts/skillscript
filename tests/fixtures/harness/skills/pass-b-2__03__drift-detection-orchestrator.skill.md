# Skill: drift-detection-orchestrator
# Description: Top-of-the-hour drift sweep — composes 3 child skills, summarizes results
# Status: Approved
# Triggers: cron: 0 * * * *

pr_count:
    $ execute_skill skill_name=pr-counter-task1 -> PR_OUT (fallback: "unavailable")

stars:
    $ execute_skill skill_name=stargazer-c1 -> STARS_OUT (fallback: "unavailable")

# FEATURE REQUEST: parallel/fan-out dispatch.
#   pr_count and stars are independent — would love an explicit
#   "parallel" hint so the runtime can schedule them concurrently.
#   Imagined:
#     parallel:
#         $ execute_skill skill_name=pr-counter-task1 -> PR_OUT
#         $ execute_skill skill_name=stargazer-c1 -> STARS_OUT
#   Today, topological order may serialize same-tier nodes.

synthesize: pr_count stars
    ~ prompt="Two-line drift digest. PRs: $(PR_OUT). Stars: $(STARS_OUT)." model=qwen maxTokens=160 -> DIGEST

emit: synthesize
    ! === Hourly drift sweep $(NOW) ===
    ! $(DIGEST|trim)

default: emit