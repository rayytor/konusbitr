#!/usr/bin/env python3
"""Generate the Python SDK's types and operation table from ``docs/openapi.json``.

Two things come out of this and neither may be hand-edited: the ``TypedDict``
shapes for every request and response, and one ``Operation`` per endpoint naming
its method, path and body mode. The hand-written half is ``client.py`` — the
retries, the typed errors, the job polling — which is deliberately not
generated, because none of that is described by an OpenAPI document and a
generator's idea of it would be worse than a page written on purpose.

``make -C sdks/python generate`` regenerates; ``generate-check`` regenerates and
diffs, which CI runs. The chain is Zod schema → route declaration → OpenAPI
document → SDK, with a drift check at every seam.

Usage: ``python scripts/generate.py [path-to-openapi.json]``
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SPEC = ROOT.parents[1] / "docs" / "openapi.json"
OUTPUT = ROOT / "src" / "konusbitr" / "_generated.py"

BANNER = '''"""Generated from the API's OpenAPI document by ``scripts/generate.py``.

**Do not edit.** Run ``make generate`` instead; CI regenerates this module and
fails on any diff.
"""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict
'''


def type_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "", name)


def ref_name(ref: str) -> str:
    return type_name(ref.rsplit("/", 1)[-1])


def render(schema: dict[str, Any] | None) -> str:
    """One schema as a Python type expression.

    Deliberately narrow: it covers what Zod emits and nothing more. Anything
    unrecognised becomes ``Any``, which is honest — a caller who has to check a
    value at runtime is being told the SDK does not know its shape, rather than
    being handed a confident wrong annotation.

    References are bare names. A ``TypedDict`` can name a type defined later in
    the module — the order the document happens to list schemas in is not a
    dependency order — and the generated module's ``from __future__ import
    annotations`` is what makes that legal without quoting every one of them.
    """
    if not schema:
        return "Any"

    if "$ref" in schema:
        return ref_name(schema["$ref"])

    for key in ("anyOf", "oneOf"):
        if isinstance(schema.get(key), list):
            return " | ".join(render(branch) for branch in schema[key])

    if isinstance(schema.get("allOf"), list):
        # Intersections have no Python spelling. The first branch is the base
        # shape in everything this document emits — a `$ref` plus the multipart
        # `file` part — and the caller passes the file separately anyway.
        return render(schema["allOf"][0])

    if isinstance(schema.get("enum"), list):
        literals = ", ".join(json.dumps(value) for value in schema["enum"])
        return f"Literal[{literals}]"

    if "const" in schema:
        return f"Literal[{json.dumps(schema['const'])}]"

    declared = schema.get("type")
    types = declared if isinstance(declared, list) else [declared] if declared else []

    if len(types) > 1:
        return " | ".join(render({**schema, "type": one}) for one in types)

    match types[0] if types else None:
        case "string":
            return "str"
        case "integer":
            return "int"
        case "number":
            return "float"
        case "boolean":
            return "bool"
        case "null":
            return "None"
        case "array":
            if isinstance(schema.get("prefixItems"), list):
                # A tuple, which is how a bounding box is described. Rendering
                # it as `list[float]` would lose the arity a caller unpacks on.
                items = ", ".join(render(item) for item in schema["prefixItems"])
                return f"tuple[{items}]"
            return f"list[{render(schema.get('items'))}]"
        case "object":
            return _render_mapping(schema)
        case _:
            return _render_mapping(schema) if schema.get("properties") else "Any"


def _render_mapping(schema: dict[str, Any]) -> str:
    """An inline object, as a mapping rather than an anonymous TypedDict.

    A nested object gets no name of its own: only the document's named
    components become ``TypedDict`` classes, because those are the shapes a
    caller holds and annotates. An inline one is described structurally.
    """
    additional = schema.get("additionalProperties")
    if not schema.get("properties"):
        if isinstance(additional, dict):
            return f"dict[str, {render(additional)}]"
        return "dict[str, Any]"
    return "dict[str, Any]"


def emit_typed_dict(name: str, schema: dict[str, Any]) -> str:
    properties: dict[str, Any] = schema.get("properties") or {}
    if not properties:
        return f"{type_name(name)} = {render(schema)}\n"

    required = set(schema.get("required") or [])
    lines = [f"class {type_name(name)}(TypedDict):"]

    description = schema.get("description")
    if description:
        lines.append(f'    """{" ".join(str(description).split())}"""')
        lines.append("")

    for key, value in properties.items():
        annotation = render(value)
        if key not in required:
            annotation = f"NotRequired[{annotation}]"
        field_doc = value.get("description")
        if field_doc:
            lines.append(f"    # {' '.join(str(field_doc).split())}")
        lines.append(f"    {key}: {annotation}")

    return "\n".join(lines) + "\n"


def emit_operations(document: dict[str, Any]) -> str:
    lines = [
        "",
        "class Operation(TypedDict):",
        '    """One endpoint, as the client needs to call it."""',
        "",
        "    method: str",
        "    path: str",
        "    params: list[str]",
        '    body: Literal["json", "json-or-multipart", "none"]',
        "    status: int",
        "    supports_async: bool",
        "",
        "",
        "#: The API version this module was generated from.",
        f"API_VERSION = {json.dumps(document['info']['version'])}",
        "",
        "",
        "OPERATIONS: dict[str, Operation] = {",
    ]

    for path, methods in sorted(document["paths"].items()):
        for method, operation in sorted(methods.items()):
            content = (operation.get("requestBody") or {}).get("content") or {}
            body = (
                "none"
                if not content
                else "json-or-multipart"
                if "multipart/form-data" in content
                else "json"
            )
            success = sorted(
                status
                for status in operation["responses"]
                if status.startswith("2") and status != "202"
            )
            params = re.findall(r"\{([^}]+)\}", path)
            supports_async = any(
                parameter.get("name") == "async" for parameter in operation.get("parameters") or []
            )

            lines.append(f"    {json.dumps(operation['operationId'])}: {{")
            lines.append(f'        "method": {json.dumps(method.upper())},')
            lines.append(f'        "path": {json.dumps(path)},')
            lines.append(f'        "params": {json.dumps(params)},')
            lines.append(f'        "body": {json.dumps(body)},')
            lines.append(f'        "status": {int(success[0]) if success else 200},')
            lines.append(f'        "supports_async": {supports_async},')
            lines.append("    },")

    lines.append("}")
    return "\n".join(lines) + "\n"


def main() -> int:
    spec = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SPEC
    document = json.loads(spec.read_text())

    parts = [BANNER, ""]
    for name, schema in sorted(document["components"]["schemas"].items()):
        parts.append(emit_typed_dict(name, schema))

    parts.append(emit_operations(document))

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text("\n".join(parts))
    print(f"sdk: wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
