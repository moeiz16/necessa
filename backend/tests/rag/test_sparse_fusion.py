from app.ai import sparse
from app.ai.retrieval.fusion import fuse, rrf


def test_tokenizer_keeps_medical_codes_intact():
    toks = sparse.tokenize(
        "CPAP E0601 for G47.33 per LCD L33718 and article A52369; NCD 150.9; CPT 29877, 0275T"
    )
    for code in ["e0601", "g47.33", "l33718", "a52369", "150.9", "29877", "0275t"]:
        assert code in toks, code
    assert "for" not in toks and "and" not in toks


def test_tokenizer_keeps_clinical_negations_and_stems_words():
    toks = sparse.tokenize("MRI without contrast; patients with no history of physical therapy")
    assert "without" in toks and "no" in toks and "with" in toks
    assert "patient" in toks and "therapi" in toks  # snowball stems


def test_ordinary_seven_letter_words_are_not_pcs_codes():
    assert not sparse.is_code_token("message")
    assert not sparse.is_code_token("pattern")
    assert sparse.is_code_token("0sp90jz")


def test_bm25_tf_saturation_and_length_normalization():
    one = sparse.encode_document("stimulator", avgdl=10)
    five = sparse.encode_document(" ".join(["stimulator"] * 5), avgdl=10)
    idx = sparse.token_index("stimul")
    v1 = dict(zip(one.indices, one.values, strict=True))[idx]
    v5 = dict(zip(five.indices, five.values, strict=True))[idx]
    assert v5 > v1
    assert v5 < sparse.K1 + 1  # saturates below k1 + 1
    short = sparse.encode_document("stimulator implant", avgdl=50)
    long = sparse.encode_document("stimulator " + "implant " * 60, avgdl=50)
    vs = dict(zip(short.indices, short.values, strict=True))[idx]
    vl = dict(zip(long.indices, long.values, strict=True))[idx]
    assert vs > vl  # longer documents are normalized down


def test_query_vector_upweights_codes_and_hash_is_stable():
    q = sparse.encode_query("E0601 adherence")
    weights = dict(zip(q.indices, q.values, strict=True))
    assert weights[sparse.token_index("e0601")] == 2.0
    assert sparse.token_index("e0601") == sparse.token_index("e0601")
    assert 0 <= sparse.token_index("anything") < 2**32


def test_rrf_rewards_agreement_across_channels():
    fused = rrf({"dense": ["a", "b", "c"], "sparse": ["b", "c", "a"]}, {"dense": 1.0, "sparse": 1.0})
    assert max(fused, key=fused.get) == "b"


def test_weighted_rrf_and_zero_weight_channel():
    fused = dict(
        fuse(
            {"dense": [("a", 0.9), ("b", 0.8)], "sparse": [("b", 12.0), ("a", 3.0)]},
            {"dense": 0.0, "sparse": 1.0},
        )
    )
    assert fused["b"] > fused.get("a", 0)
    assert "a" in fused  # present in the sparse ranking


def test_minmax_fusion_combines_scales():
    ranked = fuse(
        {"dense": [("a", 0.91), ("b", 0.90), ("c", 0.10)], "sparse": [("b", 30.0), ("a", 1.0), ("c", 0.5)]},
        {"dense": 0.5, "sparse": 0.5},
        method="minmax",
    )
    assert ranked[0][0] == "b"
