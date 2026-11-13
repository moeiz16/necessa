"""Agreement between two independently-extracted criteria trees (Zhang-Shasha tree edit distance).

Used by the compiler's cross-model verification: model A extracts, model B re-extracts; a low
normalized distance means the two models agree on the policy's logical structure and leaves.
Leaf labels are compared by token-set similarity so harmless paraphrases are not penalized.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.ai.compiler.schema import CriteriaNode, CriterionLeaf
from app.ai.compiler.text import tokenize


@dataclass
class _T:
    label: str
    is_leaf: bool
    children: list[_T] = field(default_factory=list)


def _convert(node: CriteriaNode | CriterionLeaf) -> _T:
    if isinstance(node, CriterionLeaf):
        return _T(label=node.text, is_leaf=True)
    label = f"{node.op}:{node.n}" if node.op == "N_OF_M" else node.op
    return _T(label=label, is_leaf=False, children=[_convert(c) for c in node.children])


def token_similarity(a: str, b: str) -> float:
    ta, tb = set(tokenize(a)), set(tokenize(b))
    if not ta and not tb:
        return 1.0
    return len(ta & tb) / max(1, len(ta | tb))


def _rename_cost(a: _T, b: _T) -> float:
    if a.is_leaf != b.is_leaf:
        return 1.0
    if not a.is_leaf:
        return 0.0 if a.label == b.label else 1.0
    sim = token_similarity(a.label, b.label)
    return 0.0 if sim >= 0.6 else 1.0 - sim


def _postorder(root: _T) -> tuple[list[_T], list[int], list[int]]:
    nodes: list[_T] = []
    lmd: list[int] = []  # leftmost descendant index per node

    def walk(n: _T) -> int:
        first = None
        for c in n.children:
            idx = walk(c)
            if first is None:
                first = idx
        nodes.append(n)
        my = len(nodes) - 1
        lmd.append(first if first is not None else my)
        return lmd[my]

    walk(root)
    keyroots = []
    seen: set[int] = set()
    for i in range(len(nodes) - 1, -1, -1):
        if lmd[i] not in seen:
            keyroots.append(i)
            seen.add(lmd[i])
    keyroots.sort()
    return nodes, lmd, keyroots


def tree_edit_distance(a: CriteriaNode | CriterionLeaf, b: CriteriaNode | CriterionLeaf) -> float:
    ta, tb = _convert(a), _convert(b)
    na, la, ka = _postorder(ta)
    nb, lb, kb = _postorder(tb)
    td = [[0.0] * len(nb) for _ in na]
    for i in ka:
        for j in kb:
            m = i - la[i] + 2
            n = j - lb[j] + 2
            fd = [[0.0] * n for _ in range(m)]
            ioff, joff = la[i] - 1, lb[j] - 1
            for x in range(1, m):
                fd[x][0] = fd[x - 1][0] + 1
            for y in range(1, n):
                fd[0][y] = fd[0][y - 1] + 1
            for x in range(1, m):
                for y in range(1, n):
                    xi, yj = x + ioff, y + joff
                    if la[xi] == la[i] and lb[yj] == lb[j]:
                        fd[x][y] = min(
                            fd[x - 1][y] + 1,
                            fd[x][y - 1] + 1,
                            fd[x - 1][y - 1] + _rename_cost(na[xi], nb[yj]),
                        )
                        td[xi][yj] = fd[x][y]
                    else:
                        p, q = la[xi] - 1 - ioff, lb[yj] - 1 - joff
                        fd[x][y] = min(fd[x - 1][y] + 1, fd[x][y - 1] + 1, fd[p][q] + td[xi][yj])
    return td[len(na) - 1][len(nb) - 1]


def _size(n: _T) -> int:
    return 1 + sum(_size(c) for c in n.children)


def agreement(a: CriteriaNode | CriterionLeaf, b: CriteriaNode | CriterionLeaf) -> float:
    """1.0 = identical structure & equivalent leaves, 0.0 = nothing in common."""
    dist = tree_edit_distance(a, b)
    denom = max(_size(_convert(a)), _size(_convert(b)))
    return round(max(0.0, 1.0 - dist / denom), 4)
