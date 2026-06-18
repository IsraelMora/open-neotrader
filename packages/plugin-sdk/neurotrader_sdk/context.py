from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Context:
    """
    Contexto inyectado por el runner a cada función del plugin.
    El plugin no puede modificarlo ni acceder a internet.
    """

    plugin_id: str = ""
    operator: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
