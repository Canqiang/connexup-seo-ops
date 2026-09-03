import unicodedata


def _keyword_identity(value: str) -> str:
    """Return the canonical identity used at paid keyword boundaries.

    Display text stays untouched. Identity comparison normalizes Unicode
    compatibility variants, collapses all Unicode whitespace, and ignores case.
    """

    if not isinstance(value, str):
        raise TypeError("keyword identity requires text")
    return " ".join(unicodedata.normalize("NFKC", value).split()).casefold()
