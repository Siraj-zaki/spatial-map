"""Guard the run.py → SPA contract.

The Python classifier speaks generic CV language (wall/room); the SPA
speaks warehouse-product language (aisle/area). run.py owns the
translation. If someone adds a new Kind and forgets to add a matching
entry — OR adds one but names it something the SPA doesn't switch on
in ai-accept.ts — the SPA silently drops the detection at accept time.

These tests fail loud instead.
"""

from __future__ import annotations

from aiworker.pipeline.run import _EMIT_KINDS, _KIND_TO_SPA

# Values the SPA's `AIDetectionKind` union accepts (src/lib/ai-client.ts).
# Kept as a literal so a rename on the SPA side without a Python
# update fails this test rather than the user's browser.
_SPA_KINDS = {"aisle", "area", "door", "stair"}


def test_every_emit_kind_has_a_spa_mapping() -> None:
    """A Kind that survives the classifier but has no SPA equivalent
    would arrive at the SPA as a string it doesn't recognize —
    ai-accept.ts's exhaustive switch has no default, so acceptance
    silently returns undefined."""

    missing = _EMIT_KINDS - set(_KIND_TO_SPA)
    assert not missing, (
        f"Kinds in _EMIT_KINDS missing from _KIND_TO_SPA: {missing}. "
        "Every emitted kind must have a SPA-vocabulary translation."
    )


def test_every_mapped_value_is_a_known_spa_kind() -> None:
    """Belt-and-suspenders: catches a typo like 'aisel' that would
    fall through the SPA's switch and produce a no-op accept."""

    for py_kind, spa_value in _KIND_TO_SPA.items():
        assert spa_value in _SPA_KINDS, (
            f"Kind.{py_kind.name} → '{spa_value}' is not in the SPA's "
            f"AIDetectionKind union {_SPA_KINDS}."
        )


def test_mapping_covers_all_four_product_kinds() -> None:
    """The AI Map tool advertises detection of aisles, areas, doors,
    stairs — one Python Kind must exist for each. Missing one means
    that entire category is dead in the SPA even if the SPA switch
    still handles it."""

    produced = set(_KIND_TO_SPA.values())
    assert produced == _SPA_KINDS, (
        f"Product-vocabulary coverage gap. Produced: {produced}. "
        f"Expected: {_SPA_KINDS}."
    )
