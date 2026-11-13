from app.ai.compiler.schema import CriteriaNode, CriterionLeaf, SourceSpan
from app.ai.compiler.tree_distance import agreement, token_similarity, tree_edit_distance


def leaf(i, text):
    return CriterionLeaf(id=i, text=text, source_span=SourceSpan(quote="placeholder quote text"))


def test_identical_trees_agree_fully():
    t = CriteriaNode(
        op="AND",
        children=[leaf("C1", "pain for at least three months"), leaf("C2", "failed physical therapy")],
    )
    assert tree_edit_distance(t, t) == 0
    assert agreement(t, t) == 1.0


def test_paraphrased_leaves_are_not_penalized_but_structure_is():
    a = CriteriaNode(
        op="AND",
        children=[
            leaf("C1", "pain present for at least three months"),
            leaf("C2", "other treatment modalities tried and failed"),
        ],
    )
    b = CriteriaNode(
        op="AND",
        children=[
            leaf("X", "pain present at least three months"),
            leaf("Y", "other treatment modalities have been tried and failed"),
        ],
    )
    c = CriteriaNode(op="OR", children=[leaf("X", "pain present at least three months")])
    assert agreement(a, b) == 1.0
    assert agreement(a, c) < 0.7
    assert token_similarity("AHI of 15 or more", "apnea index of 15 or more") >= 0.4
