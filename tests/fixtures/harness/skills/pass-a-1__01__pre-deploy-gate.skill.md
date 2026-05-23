# Skill: pre-deploy-gate
# Description: Interactive — before a vercel deploy, confirm with Scott and check git status. Refuses on dirty tree or "no".
# Status: Approved
# Vars: ENV=prod

snapshot:
    @ git status --porcelain -> DIFF (fallback: "??unknown")
    @ git rev-parse --short HEAD -> SHA (fallback: "??")

review: snapshot
    ! Deploy gate — env=$(ENV), HEAD=$(SHA|trim)
    if $(DIFF|trim) != "":
        ! Working tree dirty:
        ! $(DIFF)
        ! Aborting — clean the tree first.
    else:
        ?? "Confirm deploy of $(SHA|trim) to $(ENV)?" -> APPROVED
        if $(APPROVED|trim) == "yes":
            ! Proceeding with deploy of $(SHA|trim)
            $ vercel.deploy env=$(ENV) ref=$(SHA|trim) -> DEPLOY_ACK
            ! Deploy ack: $(DEPLOY_ACK)
        else:
            ! Declined — no deploy performed.

default: review