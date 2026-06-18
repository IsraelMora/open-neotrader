from __future__ import annotations

import functools
from collections.abc import Callable


def skill(name: str | None = None, description: str = ""):
    """Marca una función como skill invocable por el LLM."""

    def decorator(fn: Callable) -> Callable:
        fn.__ntpp_skill__ = True
        fn.__ntpp_name__ = name or fn.__name__
        fn.__ntpp_description__ = description

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            return fn(*args, **kwargs)

        return wrapper

    return decorator


def universe_provider(symbols: list[str]):
    """Declara los tickers que provee este plugin de universo."""

    def decorator(fn: Callable) -> Callable:
        fn.__ntpp_universe__ = True
        fn.__ntpp_symbols__ = symbols

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            return fn(*args, **kwargs)

        return wrapper

    return decorator


def discipline(rule: str):
    """Adjunta una regla de disciplina a una función de veto."""

    def decorator(fn: Callable) -> Callable:
        fn.__ntpp_discipline__ = True
        fn.__ntpp_rule__ = rule

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            return fn(*args, **kwargs)

        return wrapper

    return decorator
