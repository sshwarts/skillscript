# Skill: doc-section-stitcher
# Description: data-skill — emit a stitched doc reference block at compile time. Used by other skills via & op.
# Status: Approved
# Type: data
# Vars: SLUG

stitch:
    $ amp_render_document slug=$(SLUG) -> RENDERED
    ! $(RENDERED.markdown)

default: stitch